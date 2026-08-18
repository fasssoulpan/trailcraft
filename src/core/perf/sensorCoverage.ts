/**
 * 传感器覆盖率摘要(P3-R5 commit 2)。这是 `fit-ride-studio` 参考项目
 * "sensor coverage" 思路的移植:任何基于心率/步频/功率/气温的分析,都必须
 * 先回答"这个传感器到底记录没记录、记录了多少"这个前置问题——一条轨迹只有
 * 三分之一的点带心率读数,任何"平均心率 142"这样的数字如果不带上这个前提
 * 展示给用户,看起来就像是全程可信的心率曲线,实际上是三分之二数据缺失下
 * 拼出来的平均数,极易误导。
 *
 * 纯函数、只读 `TrackPoints`,不依赖 Track 的其它部分(kind 判别、爬升计算
 * 等)——`commit 3` 的 `insights.ts` 会消费这里的结果作为"传感器缺口"洞察
 * 的证据来源之一,但这个模块本身不需要知道任何下游用途。
 */
import type { TrackPoints } from '../model/track'

/**
 * 单个传感器列的覆盖率摘要。
 *
 * `present` 和 `coverage === 0` 是两种不同的空状态,刻意都保留、不合并:
 * - `present: false`(整列 `undefined`):设备/文件压根没有这项数据,是
 *   "没有传感器"这个更基础的事实。
 * - `present: true, coverage: 0`:列存在,但每个点的读数都是缺失哨兵(hr 的
 *   0,或 cadence/power/temperature 的 NaN)——比如心率带佩戴了但一直没有
 *   获取到心跳信号。这种情况下"有这一列"这件事本身可能会让用户误以为有
 *   数据,`coverage: 0` 必须能被区分出来,而不是和"整列不存在"混为一谈。
 */
export interface SensorCoverageStat {
  /** 该传感器列在这条轨迹上是否存在(即使整列有效读数为 0 个)。 */
  present: boolean
  /** 总点数。 */
  totalCount: number
  /** 有真实读数(非缺失哨兵)的点数。`present` 为 `false` 时恒为 0。 */
  validCount: number
  /** `validCount / totalCount`,`totalCount` 为 0 或 `present` 为 `false`
   *  时恒为 0(不产生 NaN)。 */
  coverage: number
  /** 有效读数的最小/最大/平均值——只在至少有 1 个有效读数时给出,否则
   *  `undefined`(不用 0 或其它数字冒充"没有读数可统计")。 */
  min?: number
  max?: number
  mean?: number
}

export interface SensorCoverageSummary {
  hr: SensorCoverageStat
  cadence: SensorCoverageStat
  power: SensorCoverageStat
  temperature: SensorCoverageStat
}

const ABSENT_STAT: SensorCoverageStat = { present: false, totalCount: 0, validCount: 0, coverage: 0 }

function statFromValidValues(totalCount: number, validValues: number[]): SensorCoverageStat {
  const validCount = validValues.length
  const coverage = totalCount > 0 ? validCount / totalCount : 0
  if (validCount === 0) return { present: true, totalCount, validCount, coverage }
  let min = validValues[0]
  let max = validValues[0]
  let sum = 0
  for (const v of validValues) {
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  return { present: true, totalCount, validCount, coverage, min, max, mean: sum / validCount }
}

/** `hr` 用 0 作缺失哨兵(见 `core/model/track.ts`),不是 NaN——这里单独
 *  处理,不能和 cadence/power/temperature 共用同一套"NaN 才算缺失"的判断。 */
function statForHr(hr: Uint16Array | undefined): SensorCoverageStat {
  if (!hr) return ABSENT_STAT
  const valid: number[] = []
  for (let i = 0; i < hr.length; i++) if (hr[i] !== 0) valid.push(hr[i])
  return statFromValidValues(hr.length, valid)
}

/** cadence/power/temperature 共用同一套"NaN 才算缺失"的判断(见
 *  `core/model/track.ts` 里这三个字段的注释——0 是它们的合法真实读数)。 */
function statForNaNSentinelColumn(col: Float32Array | undefined): SensorCoverageStat {
  if (!col) return ABSENT_STAT
  const valid: number[] = []
  for (let i = 0; i < col.length; i++) if (!Number.isNaN(col[i])) valid.push(col[i])
  return statFromValidValues(col.length, valid)
}

/**
 * 计算 `points` 上 hr/cadence/power/temperature 四个传感器列的覆盖率摘要。
 * 各列相互独立计算——一条轨迹完全可能心率覆盖率很高、步频完全没有(比如
 * 只戴了心率带没开踏频传感器),没有任何"其中一列决定另一列是否有意义"
 * 的耦合逻辑。
 */
export function computeSensorCoverage(points: TrackPoints): SensorCoverageSummary {
  return {
    hr: statForHr(points.hr),
    cadence: statForNaNSentinelColumn(points.cadence),
    power: statForNaNSentinelColumn(points.power),
    temperature: statForNaNSentinelColumn(points.temperature),
  }
}
