// Type-only import from `cesium/keyframes.ts` -- safe despite the "cesium/"
// path: that module has zero `cesium` (the npm package) imports anywhere in
// its own dependency chain (see its own file comment), so this creates no
// bundle-size risk, unlike the `cesium/flythrough.ts`-style modules
// `state/appStore.ts` deliberately avoids even a type import from (that one
// DOES import `cesium` at module scope). `speedOptions.ts` already
// establishes the same "pure cesium/-folder module, safe to statically
// import from main-bundle code" precedent.
import type { CameraTrack } from '../../cesium/keyframes'

export type TrackFormat = 'gpx' | 'kml' | 'fit'
export type Crs = 'wgs84' | 'gcj02' | 'bd09'

export interface TrackPoints {
  lon: Float64Array
  lat: Float64Array
  ele?: Float32Array          // 米,缺失整列 undefined,单点缺失 NaN
  time?: Float64Array         // epoch ms,同上
  /**
   * 心率(bpm)。Uint16Array 无法表示 NaN,因此此字段使用 0 作为"本点无心率读数"
   * 的哨兵值,而不是 ele/time 所用的逐点 NaN 缺失约定 —— 0 在这里永远表示"缺失",
   * 不表示"心率读数为 0"。做图表/求平均等下游处理时需要显式过滤掉 0,不能当作
   * 有效数据点。
   */
  hr?: Uint16Array
  /**
   * 步频/踏频(FIT `cadence` 字段原始读数,单位由设备决定——跑步设备通常是
   * spm,骑行设备通常是 rpm,这里不做单位换算,直接透传,和 ele/hr 对"设备
   * 给什么就存什么"的一贯做法一致)。
   *
   * 用 `Float32Array` 而不是像 `hr` 那样用整数类型 + 0 哨兵:0 是步频/踏频
   * 完全合法的真实读数(停下来的那一刻、或者滑行不蹬踏的骑行段),不能像
   * 心率那样"0 当作缺失"——心率的 0 哨兵之所以安全,是因为活人心率永远不
   * 可能真的是 0(见上方 hr 的注释);步频/踏频没有这条物理保证,借用同样
   * 的哨兵会把"真实停止"误判成"设备没有这项数据"。因此沿用 ele/time 的
   * 逐点 NaN 缺失约定:整列缺失是 `undefined`,单点缺失(该点没有踏频读数)
   * 是 `NaN`。
   */
  cadence?: Float32Array
  /**
   * 功率(瓦特,FIT `power` 字段原始读数)。哨兵选择理由与 `cadence` 完全
   * 相同——0 瓦是骑行滑行/静止时的合法真实读数,不能借用 `hr` 的 0 哨兵,
   * 因此同样用 `Float32Array` + 逐点 NaN 缺失约定(整列缺失 `undefined`)。
   */
  power?: Float32Array
  /**
   * 气温(摄氏度,FIT `temperature` 字段原始读数)。哨兵选择理由同上——0°C
   * 在越野跑常见的高海拔/夜爬场景里是完全合法的真实读数(结冰边缘温度),
   * 不能借用 `hr` 的 0 哨兵,因此同样用 `Float32Array` + 逐点 NaN 缺失约定
   * (整列缺失 `undefined`)。
   */
  temperature?: Float32Array
  /** 累计里程(米),由 geo 模块计算后挂载 */
  cumDist?: Float64Array
}

export interface TrackMeta {
  name: string
  format: TrackFormat
  fileName: string
  creator?: string
  /**
   * 展示态属性(线条颜色/粗细),不是导入产生的数据本身——放在 meta 上是
   * 为了让 `core/toolbox/ops.ts` 的每个操作(它们统一用 `{ ...src.meta, name: ... }`
   * 派生新 Track 的 meta)自动带上,不用逐个操作单独处理。缺失时由
   * `core/model/trackStyle.ts` 的 `backfillTrackStyles` 兜底分配默认值——
   * 因此这里保持可选,不强制所有 Track 构造点都显式传。
   */
  color?: string
  lineWidth?: number
  /**
   * 用户对 `core/perf/trackKind.ts` 自动判别结果(实跑/规划/待确认)的手动
   * 覆盖(P2 §3.1,里程碑 Q1)。放在 meta 上而不是新开一个顶层字段/store
   * 侧的 Record<trackId, ...>,理由和 color/lineWidth 完全一致:
   * `core/model/project.ts` 的 `trackToFeature`/`featureToTrack` 已经把整个
   * `meta` 对象原样塞进/读出工程文件的 `properties.meta`——加这个字段不需要
   * 再碰 project.ts 一行代码就自动获得持久化,旧工程文件(没有这个字段)
   * 反序列化时这里自然是 `undefined`,不会抛错(与 color/lineWidth 对旧
   * 工程文件的兼容方式相同)。
   *
   * 这里刻意不从 `core/perf/trackKind.ts` import `TrackKind` 类型,而是重复
   * 写一遍同样的字面量联合——和 `state/appStore.ts` 里 `FlythroughCameraMode`
   * 的处理理由相同:那个类型所在的模块 import 了 `Track`,反过来这里再 import
   * 它就会形成类型层面的循环依赖,重复一行字面量联合比冒这个险更便宜。
   *
   * 值为 `undefined` 表示"没有手动覆盖,以自动判别结果为准"——见
   * `core/perf/trackKind.ts` 的 `resolveTrackKind`。
   */
  kindOverride?: 'recorded' | 'planned' | 'uncertain'
  /**
   * 巡游镜头的关键帧轨道(方案 V2.1 §5.5,里程碑 P3-R3)——按里程锚定,
   * 描述这条轨迹自己的镜头编排(模板生成的关键帧和手动编辑的关键帧共用
   * 同一份数组,互不区分,见 `cesium/keyframes.ts`/`cesium/cameraTemplates.ts`
   * 各自的文件注释)。放在 meta 上而不是新开一个顶层字段/store 侧的
   * `Record<trackId, ...>`,理由和 `kindOverride`/`color`/`lineWidth` 完全
   * 一致:`trackToFeature`/`featureToTrack` 已经把整个 `meta` 对象原样
   * 塞进/读出工程文件,加这个字段不需要再碰 `project.ts` 一行代码就自动
   * 获得持久化;旧工程文件(没有这个字段)反序列化后这里自然是
   * `undefined`,`cesium/keyframes.ts#sampleCameraAt` 对空/缺失轨道的处理
   * 就是"退化为今天的默认镜头",因此旧工程原样能打开、巡游效果不变。
   *
   * 已知局限(与 `state/appStore.ts` 里 CP 重锚定的几个已知局限同类,
   * 本里程碑不解决):`core/toolbox/ops.ts` 的轨迹操作(反转/简化/拼接等)
   * 会像携带其它 meta 字段一样原样带走这份关键帧轨道,但不会重新按新的
   * 里程/点序调整——反转轨迹后,关键帧的里程锚点会明显错位。
   */
  cameraTrack?: CameraTrack
}

export interface Track {
  id: string
  meta: TrackMeta
  crs: 'wgs84'                // 内部永远 WGS-84
  originalCrs: Crs            // 导入时识别到的原始坐标系
  points: TrackPoints
}

export interface TrackPointsInput {
  lon: ArrayLike<number>; lat: ArrayLike<number>
  ele?: ArrayLike<number>; time?: ArrayLike<number>; hr?: ArrayLike<number>
  cadence?: ArrayLike<number>; power?: ArrayLike<number>; temperature?: ArrayLike<number>
}

let seq = 0
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`
}

export function createTrack(pts: TrackPointsInput, meta: TrackMeta, originalCrs: Crs = 'wgs84'): Track {
  const n = pts.lon.length
  const fields: Array<[string, ArrayLike<number> | undefined]> = [
    ['lat', pts.lat],
    ['ele', pts.ele],
    ['time', pts.time],
    ['hr', pts.hr],
    ['cadence', pts.cadence],
    ['power', pts.power],
    ['temperature', pts.temperature],
  ]
  for (const [name, arr] of fields) {
    if (arr && arr.length !== n)
      throw new Error(`point array length mismatch: ${name}.length=${arr.length}, expected ${n}`)
  }
  return {
    id: newId('trk'),
    meta, crs: 'wgs84', originalCrs,
    points: {
      lon: Float64Array.from(pts.lon), lat: Float64Array.from(pts.lat),
      ele: pts.ele ? Float32Array.from(pts.ele) : undefined,
      time: pts.time ? Float64Array.from(pts.time) : undefined,
      hr: pts.hr ? Uint16Array.from(pts.hr) : undefined,
      cadence: pts.cadence ? Float32Array.from(pts.cadence) : undefined,
      power: pts.power ? Float32Array.from(pts.power) : undefined,
      temperature: pts.temperature ? Float32Array.from(pts.temperature) : undefined,
    },
  }
}

export function trackPointCount(t: Track): number { return t.points.lon.length }
