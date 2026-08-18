/**
 * 把一批带 EXIF GPS 的照片锚定到某条轨迹上,批量生成/更新 CheckPoint——
 * P3-R2 commit 3,方案 V2.1 §5.1「CP 点系统…挂载实景照片(自动读取 EXIF
 * GPS 纠偏)」承诺的部分,从 P0 拖到现在才交付。
 *
 * 纯函数,不碰 DOM/store,只依赖 `Track` 的几何和已有的 `CheckPoint[]`——
 * 因此可以被 `tests/core/photoAnchor.test.ts` 直接单测(EXIF 解析本身
 * 已经在 commit 1 单测过,这里只测"给定坐标,锚定/拒绝/合并的判定对不对",
 * 用手写的经纬度而不是真实照片)。UI 侧(`CpPanel.tsx`)只负责收集文件、
 * 调 `attachPhoto.ts` 拿到每张照片的 GPS/缩略图,再把结果喂给这个函数。
 */
import { newId, type Track } from '../model/track'
import type { CheckPoint, CpKind } from '../model/checkpoint'
import { anchorMonotonic } from '../stats/anchor'
import { nearestVertex } from '../geo/nearestVertex'
import { haversine } from '../geo/distance'

/**
 * 距轨迹超过这个距离(米)的照片,拒绝自动锚定,而不是"就近"硬贴上去。
 *
 * 越野赛道场景下,手机 GPS 在树冠遮挡/峡谷地形里的定位误差常见到 30-50m,
 * 偶尔上百米;而拍照的人往往也不是精确站在轨迹线本身上(比如从补给站帐篷
 * 门口拍,或者对着路边的地标拍)。150m 留出了这些"合理误差"的余量,同时
 * 仍然能挡住真正对不上号的照片——一条越野赛道上,两个真实检查点之间的
 * 间距几乎总是几百米起、常见几公里,150m 不会把"这明明是另一个检查点甚至
 * 完全不相关的照片"错误地吞进来。拒绝而不是静默贴错位置,是
 * `docs/P0-验收记录.md` §五要求的"宁可大声报错,不要默默编造数据"在这里
 * 的直接体现——把它当作 CP 的位置本身就是一种编造。
 */
export const PHOTO_ANCHOR_MAX_DISTANCE_M = 150

/**
 * 一张照片的 GPS 位置如果落在已有 CP 这个距离(米)以内,视为"就是它",
 * 更新那个 CP 的照片而不是新建一个几乎重叠的 CP。
 *
 * 明显比 `PHOTO_ANCHOR_MAX_DISTANCE_M` 更严——"这是同一个检查点"要比
 * "这张照片大致在赛道附近"要求高得多。50m 之所以够用:CP 的位置来源
 * 本就有两种常见误差(用户在地图上点击选点的手工精度、照片的手机 GPS
 * 定位误差),两者相加通常也就是几米到大约二三十米量级;而两个不同检查点
 * 之间(前面说过)几乎总是几百米以上。50m 在两者之间留了充分的安全边际。
 * 这个规则也顺带让"同一批照片重复导入一次"变成幂等操作——第二次导入时
 * 每张照片都会精确匹配上第一次导入时它自己创建的那个 CP(距离约等于 0),
 * 更新而不是重复创建。
 */
export const PHOTO_MERGE_DISTANCE_M = 50

export interface PhotoGpsInput {
  /** 建议的 CP 名称——目前调用方(CpPanel.tsx)传文件名(去掉扩展名);
   * EXIF 本身不包含地名,这是唯一现成能用的默认值,用户可以在 CpPanel
   * 里随时改。 */
  name: string
  lat: number
  lon: number
  /** 已经缩放/摆正/去除 EXIF 的照片,见 `core/photo/attachPhoto.ts`。 */
  photoUrl: string
  /**
   * EXIF DateTimeOriginal 解析出的拍摄时间——刻意提取但目前**不用于**
   * 锚定计算,只是先把这份数据带过来,为将来铺路。原因:
   *  - 主锚定信号必须能有一个干净的"拒绝"机制,GPS 天然有(见上面
   *    `PHOTO_ANCHOR_MAX_DISTANCE_M`——离轨迹太远就是太远,判断直接);
   *    时间锚定要判断"这个时间点对不上"依赖手机时钟和记录轨迹的设备
   *    (手表/GPX 记录器)时钟严格同步,现实中这个前提经常不成立(手机
   *    时钟漂移、用户没对时、甚至跨时区忘记调整),一旦不成立,时间锚定
   *    会在没有任何征兆的情况下把照片错误地"自信地"锚到完全不同的位置
   *    ——比 GPS 误差更难被这里的距离阈值那类简单规则挡住。
   *  - 只有当轨迹本身带 `points.time`(并非所有导入的轨迹都有)时,时间
   *    信号才谈得上可用,进一步缩小了它能覆盖的场景。
   *  综合权衡后决定:这一版只用 GPS 做主锚定;`dateTimeOriginalMs` 先随
   *  数据流带过来,为未来"GPS 锚定结果 vs 轨迹时间戳"的交叉校验(作为
   *  不阻断、只提示的第二信号)留一个不需要改调用方的口子。
   */
  dateTimeOriginalMs?: number
}

export interface RejectedPhoto {
  input: PhotoGpsInput
  /** 该照片 GPS 位置到轨迹最近点的实际距离(米),供 UI 原样展示给用户
   * ("XXX 距轨迹 218m,已跳过"),而不是一句笼统的"失败"。 */
  distanceM: number
}

export interface PhotoAnchorResult {
  /** 新建的 CP。 */
  created: CheckPoint[]
  /** 命中"附近已有 CP"而只更新了 photoUrl 字段的 CP——完整的新对象(浅拷贝
   * 自调用方传入的 `existingCps` 里对应的那个),调用方应当直接用它替换
   * 原对象,而不是再自己 diff 一遍改了什么字段。 */
  updated: CheckPoint[]
  rejected: RejectedPhoto[]
}

/**
 * `existingCps` 必须已经是"只属于 `track`"的子集——和 `checkpointApproach.ts`/
 * `cpEntities.ts` 同一条防御性约定(见那些文件的注释:不信任调用方一定
 * 记得过滤,P0 就是从"忘记按 trackId 过滤"里出的那类 bug),这里改为主动
 * 声明前提交给调用方保证,是因为调用方(CpPanel.tsx)本来就已经手上只有
 * 当前激活轨迹的 CP 子集(`cps` 变量,见该文件顶部的同款过滤注释),重复
 * 过滤一遍纯属多余。
 */
export function anchorPhotosToTrack(
  track: Track,
  existingCps: CheckPoint[],
  photos: PhotoGpsInput[],
  kind: CpKind = 'landmark',
): PhotoAnchorResult {
  if (photos.length === 0) return { created: [], updated: [], rejected: [] }
  const { lon, lat } = track.points

  const withNearest = photos.map((p) => ({ p, nearest: nearestVertex(lon, lat, p.lon, p.lat) }))
  const rejected: RejectedPhoto[] = []
  const inRange: typeof withNearest = []
  for (const item of withNearest) {
    if (item.nearest.distanceM > PHOTO_ANCHOR_MAX_DISTANCE_M) {
      rejected.push({ input: item.p, distanceM: item.nearest.distanceM })
    } else {
      inRange.push(item)
    }
  }

  // 同 checkpointImport.ts 的两阶段预处理:先按各自独立算出的、无单调
  // 约束的最近点下标排序,再整批喂给 anchorMonotonic——见该文件顶部注释,
  // 这里面对的是同一个问题形状(输入顺序——这里是"用户在文件选择器里选中
  // 文件的顺序"——不保证等于沿赛道前进的顺序)。
  const sorted = [...inRange].sort((a, b) => a.nearest.index - b.nearest.index)
  const anchoredIndices = anchorMonotonic(lon, lat, sorted.map(({ p }) => [p.lon, p.lat] as [number, number]))

  const created: CheckPoint[] = []
  const updated: CheckPoint[] = []
  sorted.forEach(({ p }, i) => {
    const merge = findMergeTarget(track, existingCps, p)
    if (merge) {
      // 复用已有 CP 的位置/名称/类型,只换照片——这不是"重新锚定"这个 CP,
      // 它本来就已经在正确的位置了(否则不会落在 PHOTO_MERGE_DISTANCE_M
      // 以内),所以刻意不用上面 anchorMonotonic 为这张照片算出的下标去
      // 覆盖它的 anchorIndex。
      updated.push({ ...merge, photoUrl: p.photoUrl })
    } else {
      created.push({
        id: newId('cp'),
        trackId: track.id,
        name: p.name,
        kind,
        anchorIndex: anchoredIndices[i],
        clickLngLat: [p.lon, p.lat],
        photoUrl: p.photoUrl,
      })
    }
  })

  return { created, updated, rejected }
}

/** 已有 CP 的"位置"优先取 `clickLngLat`(用户当初点击/照片当初落点的
 * 原始坐标,精度最高),缺失时退化到 anchorIndex 对应的轨迹坐标。 */
function findMergeTarget(track: Track, existingCps: CheckPoint[], p: PhotoGpsInput): CheckPoint | undefined {
  const { lon, lat } = track.points
  let best: CheckPoint | undefined
  let bestDist = Infinity
  for (const cp of existingCps) {
    if (cp.trackId !== track.id) continue
    const idx = Math.min(Math.max(cp.anchorIndex, 0), lon.length - 1)
    const [cpLon, cpLat] = cp.clickLngLat ?? [lon[idx], lat[idx]]
    const d = haversine(p.lon, p.lat, cpLon, cpLat)
    if (d <= PHOTO_MERGE_DISTANCE_M && d < bestDist) {
      bestDist = d
      best = cp
    }
  }
  return best
}
