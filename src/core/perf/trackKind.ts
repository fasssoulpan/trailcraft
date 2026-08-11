/**
 * 实跑 vs 规划轨迹判别(P2 §3.1,里程碑 Q1)。
 *
 * 这是"能不能给一条轨迹算表现分"的开关——给规划路线算表现分毫无意义且会
 * 误导用户(路线文件根本没有"跑得怎么样"这回事)。判定因此刻意做成三态
 * (`recorded`/`planned`/`uncertain`)而不是布尔值:证据不足时绝不猜,交给
 * UI 提示用户手动指定,错判的代价(给用户一个假分数)远大于"暂时不确定"。
 *
 * 纯函数、不依赖任何框架/浏览器 API——只读 `Track` 的列式数据,可在 Node
 * 环境下被 Vitest 直接单测。
 */
import type { Track } from '../model/track'
import { computeCumDist } from '../geo/distance'

export type TrackKind = 'recorded' | 'planned' | 'uncertain'

/** 判别过程中用到的原始信号,原样暴露出来,让 UI 能"展示判断依据"而不是
 *  当一个黑盒——用户如果不同意判定结果,至少能看懂为什么。*/
export interface TrackKindSignals {
  /** 是否存在 `time` 列(哪怕只有部分点有值)。规划工具导出的路线通常完全没有这一列。 */
  hasTime: boolean
  /** 轨迹点数,用于判断下面几项信号是否有足够样本可用。 */
  pointCount: number
  /** 全程里程(米)。优先读 `points.cumDist`,缺失时现算。 */
  distanceM: number
  /** 首尾时间戳之差(秒)。`hasTime` 为 false 或点数不足 2 时缺省。 */
  elapsedS?: number
  /** `distanceM / elapsedS`。 */
  avgSpeedMPS?: number
  /** 平均速度是否落在人类越野跑/徒步运动的合理区间。 */
  speedPlausible?: boolean
  /** 参与采样间隔规律性判断的相邻间隔样本数(点数不足时可能是 0)。 */
  intervalSampleCount: number
  /** 相邻采样间隔的变异系数(标准差/均值)。样本不足时缺省。 */
  intervalCV?: number
  /** 采样间隔是否"过于规整"(变异系数低于阈值)——真实设备记录的间隔会
   *  抖动(且常见连续重复时间戳),完全均匀的间隔是合成时间轴的红旗信号。 */
  intervalUniform?: boolean
  /** 是否存在有效心率读数(`points.hr` 里至少一个非 0 值——0 是缺失哨兵值,
   *  不代表心率读数为 0,详见 `core/model/track.ts` 对 `hr` 字段的注释)。 */
  hasHr: boolean
}

export interface TrackKindResult {
  kind: TrackKind
  /** 中文说明,给 UI 直接展示——用户可能需要据此决定是否覆盖判定结果。 */
  reason: string
  signals: TrackKindSignals
}

/**
 * 平均速度合理区间(米/秒)。刻意取得很宽松:下限 0.1 m/s(约 360 m/h)
 * 覆盖含大量休整的慢速徒步/超长耐力活动;上限 10 m/s(36 km/h)远高于
 * 越野跑全程均速,只用来排除"时间戳与里程明显对不上"的离谱情况
 * (例如 109.7km 在 20 分钟内跑完,~91 m/s)。
 */
const MIN_PLAUSIBLE_SPEED_MPS = 0.1
const MAX_PLAUSIBLE_SPEED_MPS = 10

/** 少于这个数目的相邻间隔样本,不足以判断"规律"还是"抖动",判为数据不足。 */
const MIN_INTERVAL_SAMPLES = 4

/** 间隔变异系数低于此值,视为"过于规整"——真实 COROS 设备记录里大量出现
 *  重复时间戳与整秒跳变的混合,变异系数远高于这个值;只有等速合成的时间轴
 *  才会低到这里。 */
const UNIFORM_CV_THRESHOLD = 0.05

/**
 * 命中判定的分数阈值。信号按"可靠性"加权累加(见下方 classifyTrack 内联
 * 注释的每一步),最终按阈值收敛成三态——阈值刻意不对称:
 * - `planned` 的阈值(-3)几乎只需要"完全没有时间列"这一个信号(权重 -4)
 *   就能独自触发,因为这本身就是最强证据(P0 已实测两条真实规划 KML 均无
 *   时间列);
 * - `recorded` 的阈值(4)刻意设得让任何单一信号都不足以独自触发(哪怕是
 *   最强的心率信号,权重也只有 +3),必须至少两个独立信号同时指向"这是一
 *   次真实记录",避免仅凭一条弱证据就给用户一个自信满满的错误判定。
 */
const SCORE_RECORDED = 4
const SCORE_PLANNED = -3

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function classifyTrack(track: Track): TrackKindResult {
  const { lon, lat, time, hr } = track.points
  const n = lon.length

  let hasHr = false
  if (hr) {
    for (let i = 0; i < hr.length; i++) {
      if (hr[i] !== 0) { hasHr = true; break }
    }
  }

  const cumDist = track.points.cumDist ?? computeCumDist(lon, lat)
  const distanceM = cumDist.length > 0 ? cumDist[cumDist.length - 1] : 0

  let score = 0
  const reasons: string[] = []

  let elapsedS: number | undefined
  let avgSpeedMPS: number | undefined
  let speedPlausible: boolean | undefined
  let intervalSampleCount = 0
  let intervalCV: number | undefined
  let intervalUniform: boolean | undefined

  const hasTime = !!time && time.length > 0

  if (!hasTime) {
    // 信号 1(最可靠):完全没有时间列,规划工具导出的路线的典型特征。
    score -= 4
    reasons.push('轨迹不含时间戳，规划路线通常没有时间列')
  } else {
    // 有时间列本身是弱证据——规划工具一般不带时间,但不能排除极少数例外,
    // 所以只给一个小的正向权重,真正的判断力来自下面两项细分信号。
    score += 1

    elapsedS = (time[n - 1] - time[0]) / 1000

    // 信号 2:时长/里程换算出的平均速度是否落在人类运动的合理区间——用来
    // 排除"有时间戳,但时间戳与里程根本对不上"(比如等速合成、或者数据
    // 损坏)的情况。点数不足或时长为零时没有意义,跳过不计分。
    if (n >= 2 && elapsedS > 0) {
      avgSpeedMPS = distanceM / elapsedS
      speedPlausible = avgSpeedMPS >= MIN_PLAUSIBLE_SPEED_MPS && avgSpeedMPS <= MAX_PLAUSIBLE_SPEED_MPS
      if (speedPlausible) {
        score += 2
        reasons.push(`平均速度 ${avgSpeedMPS.toFixed(2)} m/s 落在人类运动合理区间`)
      } else {
        score -= 4
        reasons.push(`平均速度 ${avgSpeedMPS.toFixed(2)} m/s 超出人类运动合理区间，时间戳与里程不匹配`)
      }
    } else {
      reasons.push('时长为零或点数不足，无法判断速度是否合理')
    }

    // 信号 3:采样间隔的规律性。真实设备记录的间隔会抖动(常见连续重复
    // 时间戳,即 delta=0,与整秒跳变混合),TrailCraft 自己合成的等速时间轴
    // (见 cesium/trackGeometry.ts 的 synthesizeTimeline)则完全均匀——
    // 用变异系数而不是"是否存在相同间隔"来判断,正是为了不把真实设备里
    // 大量出现的重复时间戳误判成"不规律"(它们和其它非零间隔混在一起,
    // 反而拉高了变异系数)。
    const deltas: number[] = []
    for (let i = 1; i < n; i++) {
      const d = time[i] - time[i - 1]
      if (Number.isFinite(d) && d >= 0) deltas.push(d)
    }
    intervalSampleCount = deltas.length
    if (deltas.length >= MIN_INTERVAL_SAMPLES) {
      const m = mean(deltas)
      const variance = mean(deltas.map((d) => (d - m) ** 2))
      const sd = Math.sqrt(variance)
      intervalCV = m > 0 ? sd / m : 0 // 均值为 0 说明所有间隔恰好都是 0,本身就是极端规整
      intervalUniform = intervalCV < UNIFORM_CV_THRESHOLD
      if (intervalUniform) {
        score -= 2
        reasons.push('采样间隔几乎完全均匀，疑似合成时间轴而非设备实录')
      } else {
        score += 1
        reasons.push('采样间隔存在真实设备常见的抖动/重复时间戳')
      }
    }
  }

  // 信号 4:传感器列。规划工具产出的路线不可能带心率数据,存在即是较强
  // 证据；缺失则是中性的(不少真实记录本身也不戴心率带),不扣分。
  if (hasHr) {
    score += 3
    reasons.push('含心率读数，规划工具不会产生心率数据')
  }

  let kind: TrackKind
  if (score >= SCORE_RECORDED) kind = 'recorded'
  else if (score <= SCORE_PLANNED) kind = 'planned'
  else kind = 'uncertain'

  const prefix =
    kind === 'recorded' ? '判定为实跑记录：' : kind === 'planned' ? '判定为规划路线：' : '证据不足，无法确定：'
  const reason = prefix + reasons.join('；')

  return {
    kind,
    reason,
    signals: {
      hasTime,
      pointCount: n,
      distanceM,
      elapsedS,
      avgSpeedMPS,
      speedPlausible,
      intervalSampleCount,
      intervalCV,
      intervalUniform,
      hasHr,
    },
  }
}

/** 三态判别结果给 UI 用的中文标签。`TrackList.tsx` 的判别徽章、
 *  `resolveTrackKind` 生成的覆盖说明文案都从这里取,保证两处文案不会各写
 *  一遍互相走样。 */
export const TRACK_KIND_LABEL: Record<TrackKind, string> = {
  recorded: '实跑',
  planned: '规划路线',
  uncertain: '待确认',
}

/**
 * `classifyTrack` 的 `WeakMap` 记忆化包装——分类结果只依赖 `track.points`
 * (不可变,见 `core/model/track.ts`),和 `src/ui/hudStats.ts` 的
 * `getHudTrackStats`/`src/map/trackLayer.ts` 的 `renderCopy` 用的是同一个
 * 缓存约定:键是 `Track` 对象本身,身份不变就不重算。这是三十万点级别的
 * 轨迹能不能在每次渲染时都跑一遍 `classifyTrack` 而不卡顿的关键——不加这层,
 * HUD/TrackList 任何一次订阅 store 触发的重渲染都会把整条轨迹重新扫一遍。
 *
 * 和 `getHudTrackStats` 一样,`meta` 变了(比如改颜色/覆盖判别结果本身)
 * 会产出一个新的 `Track` 对象、连带让这里缓存未命中——这是已知的、和
 * `getHudTrackStats` 相同的成本特征(该文件的注释也承认了这一点),不是本
 * 模块试图掩盖的新问题。
 */
const kindCache = new WeakMap<Track, TrackKindResult>()

export function getTrackKind(track: Track): TrackKindResult {
  const cached = kindCache.get(track)
  if (cached) return cached
  const result = classifyTrack(track)
  kindCache.set(track, result)
  return result
}

/** `resolveTrackKind` 的返回值——在 `TrackKindResult` 之上多标一个
 *  `overridden`,让 UI 能区分"这是算法判的"还是"用户自己指定的",不需要
 *  另外去读 `track.meta.kindOverride` 做同样的判断。 */
export interface ResolvedTrackKind extends TrackKindResult {
  overridden: boolean
}

/**
 * 判别结果的唯一"对外"入口:有手动覆盖(`track.meta.kindOverride`,见该
 * 字段的文档注释)就用覆盖值,否则用(缓存过的)自动判别结果。UI 一律应该
 * 调这个函数,而不是直接调 `classifyTrack`/`getTrackKind`——直接调后者会在
 * 用户已经手动指定过的轨迹上显示算法的判断而不是用户的决定,正是 P2 §3.1
 * 要求"误判时用户可手动覆盖"要覆盖掉的东西。
 *
 * 覆盖后的 `reason`/`signals` 仍然把自动判别的原始依据带出来(标注在文案
 * 里、原样保留在 `signals` 上),而不是丢弃——用户手动改判之后,自动判别
 * 当初为什么算错(或者其实没错、只是证据不足)依然是有用的调试信息。
 */
export function resolveTrackKind(track: Track): ResolvedTrackKind {
  const auto = getTrackKind(track)
  const override = track.meta.kindOverride
  if (!override) return { ...auto, overridden: false }
  return {
    kind: override,
    reason: `用户手动指定为${TRACK_KIND_LABEL[override]}（自动判定：${TRACK_KIND_LABEL[auto.kind]}）`,
    signals: auto.signals,
    overridden: true,
  }
}
