import type { Track } from '../model/track'
import type { CheckPoint } from '../model/checkpoint'
import { smoothElevation, computeGainLoss } from './elevation'

export interface SegmentStats {
  fromName: string
  toName: string
  fromIndex: number
  toIndex: number
  dist: number // 米
  gain: number
  loss: number
  gainRate: number // gain/dist
  lossRate: number // loss/dist
  netSlope: number // (终点海拔 − 起点海拔)/dist
}

export interface StatsOptions {
  threshold?: number
  smoothWindow?: number
}

const DEFAULT_THRESHOLD = 5
const DEFAULT_SMOOTH_WINDOW = 5
const START_NAME = '起点'
const END_NAME = '终点'

interface Boundary { name: string; index: number }

/**
 * 按 起点 / 各 CP(按 anchorIndex 排序) / 终点 切分区间,逐段统计距离、
 * 爬升、下降与坡度。
 *
 * 刻意报告三个不同的坡度指标(区间爬升率、区间下降率、净坡度),而不是只给
 * "净坡度"一个数:一段先爬 400m 再降 400m 的山路净坡度是 0,但显然不是
 * "平地"——只看净坡度会把这类路段误判为平坦。
 */
export function computeSegments(track: Track, cps: CheckPoint[], opt: StatsOptions = {}): SegmentStats[] {
  const { points } = track
  const n = points.lon.length
  const cumDist = points.cumDist
  if (!cumDist) throw new Error('computeSegments: track.points.cumDist is required (call computeCumDist first)')

  const threshold = opt.threshold ?? DEFAULT_THRESHOLD
  const smoothWindow = opt.smoothWindow ?? DEFAULT_SMOOTH_WINDOW
  const smoothed = points.ele ? smoothElevation(points.ele, smoothWindow) : undefined

  const sortedCps = [...cps].sort((a, b) => a.anchorIndex - b.anchorIndex)
  const boundaries: Boundary[] = [
    { name: START_NAME, index: 0 },
    ...sortedCps.map((cp) => ({ name: cp.name, index: cp.anchorIndex })),
    { name: END_NAME, index: n - 1 },
  ]

  const segments: SegmentStats[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i]
    const to = boundaries[i + 1]
    const dist = cumDist[to.index] - cumDist[from.index]

    let gain = 0
    let loss = 0
    if (smoothed) {
      const slice = smoothed.subarray(from.index, to.index + 1)
      const gl = computeGainLoss(slice, threshold)
      gain = gl.gain
      loss = gl.loss
    }

    let netSlope = 0
    if (points.ele && dist > 0) {
      netSlope = (points.ele[to.index] - points.ele[from.index]) / dist
    }

    segments.push({
      fromName: from.name,
      toName: to.name,
      fromIndex: from.index,
      toIndex: to.index,
      dist,
      gain,
      loss,
      gainRate: dist > 0 ? gain / dist : 0,
      lossRate: dist > 0 ? loss / dist : 0,
      netSlope,
    })
  }
  return segments
}

/**
 * 在 [3,10] 区间以 0.5 步长网格搜索阈值,返回总爬升最接近 officialGain 的一个,
 * 用来把平台自己的爬升算法标定到官方(赛事方/其它平台)公布的数字。
 */
export function calibrateThreshold(track: Track, officialGain: number, opt: StatsOptions = {}): number {
  if (!track.points.ele) throw new Error('calibrateThreshold: track has no elevation data')
  const smoothWindow = opt.smoothWindow ?? DEFAULT_SMOOTH_WINDOW
  const smoothed = smoothElevation(track.points.ele, smoothWindow)

  let best = DEFAULT_THRESHOLD
  let bestDiff = Infinity
  for (let t = 3; t <= 10; t += 0.5) {
    const { gain } = computeGainLoss(smoothed, t)
    const diff = Math.abs(gain - officialGain)
    if (diff < bestDiff) {
      bestDiff = diff
      best = t
    }
  }
  return best
}
