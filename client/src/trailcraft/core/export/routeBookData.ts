/**
 * 路书套件(Excel、配速卡)共用的核心数据层——P3-R1 commit 2/3。
 *
 * 和 `SegmentTable.tsx`/`profileGraphic.ts` 一样,只调用 `computeSegments`/
 * `estimateArrivals`/`alignCutoffsToSegments` 这几个既有纯函数,不重新推导
 * 任何一条计算规则,这样 Excel 路书、配速卡里的数字才能保证和屏幕上分段表
 * 显示的数字一致——这是本任务书反复强调的"不能自相矛盾"要求。
 *
 * 每一行(`RouteBookRow`)额外携带累计里程/累计爬升/累计下降
 * (`cumDistM`/`cumGainM`/`cumLossM`),供配速卡这类"到某个 CP 为止总共爬了
 * 多少"的展示直接读取,不需要在配速卡里重新对 rows 数组求前缀和(否则又是
 * 一份可能和这里算出的总数对不上的独立实现)。
 */
import type { Track } from '../model/track'
import type { CheckPoint } from '../model/checkpoint'
import { computeSegments, type SegmentStats, type StatsOptions } from '../stats/segments'
import { sortCpsByAnchor, alignCutoffsToSegments } from '../stats/cutoffAlign'
import { estimateArrivals, type PaceParams, type WarnLevel } from '../pace/models'

/** 路书套件专用的错误类型——UI 层可以用 `instanceof` 判定"这是一个数据缺失
 * 导致的可预期拒绝",而不是把它和编程错误混在一起处理。message 本身已经
 * 是可以直接展示给用户的中文提示。 */
export class RouteBookDataError extends Error {}

export interface RouteBookRow {
  fromName: string
  toName: string
  distM: number
  gain: number
  loss: number
  gainRate: number
  netSlope: number
  /** 从起点累计到本段终点的里程/爬升/下降(米)。 */
  cumDistM: number
  cumGainM: number
  cumLossM: number
  /** 未提供有效起跑时间时为 undefined——不用 0 冒充"没算出来"。 */
  segTimeSec: number | undefined
  etaMs: number | undefined
  cutoffMs: number | undefined
  level: WarnLevel | undefined
  /** Infinity(无关门时间)已经在这里被规整成 undefined,调用方不需要再各自
   * 判断 `Number.isFinite`。 */
  marginSec: number | undefined
}

export interface RouteBookData {
  trackName: string
  totalDistM: number
  totalGainM: number
  totalLossM: number
  paceParams: PaceParams
  /** 起跑时间无效(不影响本函数是否抛错,只是这一路的到达/关门列全变
   * undefined,与 SegmentTable.tsx 的降级行为一致)时为 undefined。 */
  startMs: number | undefined
  finishEtaMs: number | undefined
  rows: RouteBookRow[]
  /** 按 anchorIndex 排序后的 CP 列表,供配速卡这类需要原始 CP 对象
   * (比如 kind)的调用方使用,避免再自己重新排序/过滤一遍。 */
  sortedCps: CheckPoint[]
}

/** `buildRouteBookRows`'s return, everything `buildRouteBookData` needs to
 * assemble its public `RouteBookData` on top of. */
export interface RouteBookRows {
  rows: RouteBookRow[]
  totalDistM: number
  totalGainM: number
  totalLossM: number
  startMs: number | undefined
  finishEtaMs: number | undefined
}

/**
 * The row-building tail of `buildRouteBookData`, factored out so P3-R4's
 * interactive-page export (`core/export/webPage.ts`) can produce rows that
 * are *identical by construction* to the Excel/pace-card rows for the same
 * track — not merely "computed the same way" by a second hand-written copy
 * that could quietly drift the next time this logic changes.
 *
 * Deliberately more permissive than `buildRouteBookData` itself: takes
 * `segments`/`sortedCps` already computed by the caller (so it has no
 * opinion on whether zero CPs or missing elevation should be rejected —
 * `computeSegments` already tolerates both, returning 0 gain/loss when there
 * is no elevation column and a single start→finish segment when there are no
 * CPs) and accepts `paceParams`/`raceStartTimeIso` as optional: passing
 * `undefined` for either simply means every row's segTimeSec/etaMs/level/
 * marginSec comes back `undefined`, the same degraded-but-valid shape
 * `buildRouteBookData` already produces for an unparseable start time.
 * `buildRouteBookData`'s own call site below still always supplies both, so
 * this widening changes no existing behaviour.
 */
export function buildRouteBookRows(
  segments: SegmentStats[],
  sortedCps: CheckPoint[],
  paceParams: PaceParams | undefined,
  raceStartTimeIso: string | undefined,
): RouteBookRows {
  const cutoffsMs = alignCutoffsToSegments(segments, sortedCps)

  const parsedStartMs = raceStartTimeIso !== undefined ? Date.parse(raceStartTimeIso) : NaN
  const startMs = paceParams !== undefined && !Number.isNaN(parsedStartMs) ? parsedStartMs : undefined
  const arrivals = startMs !== undefined ? estimateArrivals(segments, paceParams as PaceParams, startMs, cutoffsMs) : undefined

  let cumDistM = 0
  let cumGainM = 0
  let cumLossM = 0
  const rows: RouteBookRow[] = segments.map((s, i) => {
    cumDistM += s.dist
    cumGainM += s.gain
    cumLossM += s.loss
    const arrival = arrivals?.[i]
    const prevEtaMs = i === 0 ? startMs : arrivals?.[i - 1]?.etaMs
    const segTimeSec = arrival && prevEtaMs !== undefined ? (arrival.etaMs - prevEtaMs) / 1000 : undefined
    return {
      fromName: s.fromName,
      toName: s.toName,
      distM: s.dist,
      gain: s.gain,
      loss: s.loss,
      gainRate: s.gainRate,
      netSlope: s.netSlope,
      cumDistM,
      cumGainM,
      cumLossM,
      segTimeSec,
      etaMs: arrival?.etaMs,
      cutoffMs: cutoffsMs[i],
      level: arrival?.level,
      marginSec: arrival && Number.isFinite(arrival.marginSec) ? arrival.marginSec : undefined,
    }
  })

  return {
    rows,
    totalDistM: cumDistM,
    totalGainM: cumGainM,
    totalLossM: cumLossM,
    startMs,
    finishEtaMs: arrivals?.[arrivals.length - 1]?.etaMs,
  }
}

/**
 * 构建路书数据。三种缺失数据的拒绝(而不是生成一份带虚构/零值的文档,见
 * 本任务书对 `docs/P0-验收记录.md` §五 的引用):
 *
 * - 没有里程(cumDist):任何一行的距离都算不出来。
 * - 没有海拔:爬升/下降是路书的核心信息,没有就不该显示成 0。
 * - 零个 CP:路书/配速卡的存在意义就是逐个检查点的信息,零个检查点意味着
 *   没有内容可生成。
 *
 * 起跑时间无效(解析失败)不在拒绝之列——和 SegmentTable.tsx 的降级行为
 * 一致,只是让每一行的 segTimeSec/etaMs/level/marginSec 都是 undefined,
 * 距离/爬升/下降这些不依赖起跑时间的信息仍然正常输出。
 */
export function buildRouteBookData(
  track: Track,
  cps: CheckPoint[],
  paceParams: PaceParams,
  statsOptions: StatsOptions,
  raceStartTimeIso: string,
): RouteBookData {
  if (!track.points.cumDist) {
    throw new RouteBookDataError('该轨迹缺少里程数据，无法生成路书')
  }
  if (!track.points.ele) {
    throw new RouteBookDataError('该轨迹缺少海拔数据，无法生成含爬升/下降信息的路书')
  }

  // s.cps 在真实 store 里是跨所有轨迹的数组(见 SegmentTable.tsx 同样的
  // trackId 过滤注释),必须先按 trackId 过滤才能得到属于这条轨迹自己的 CP。
  const trackCps = cps.filter((c) => c.trackId === track.id)
  if (trackCps.length === 0) {
    throw new RouteBookDataError('该轨迹尚未标记任何检查点（CP），无法生成路书')
  }

  const segments = computeSegments(track, trackCps, statsOptions)
  const sortedCps = sortCpsByAnchor(trackCps)
  const { rows, totalDistM, totalGainM, totalLossM, startMs, finishEtaMs } =
    buildRouteBookRows(segments, sortedCps, paceParams, raceStartTimeIso)

  return {
    trackName: track.meta.name,
    totalDistM,
    totalGainM,
    totalLossM,
    paceParams,
    startMs,
    finishEtaMs,
    rows,
    sortedCps,
  }
}
