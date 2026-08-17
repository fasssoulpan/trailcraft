/**
 * 把 CP 的关门时间对齐到 `computeSegments` 切分出来的分段上——抽出自
 * `SegmentTable.tsx`(该组件曾经内联这份逻辑),因为 P3-R1 的路书导出套件
 * (Excel 节点明细、配速卡)需要和分段表完全一致的对齐结果:两处各写一份,
 * 未来改动分段边界规则时极容易漏改一处,导致导出文件和屏幕显示的关门预警
 * 对不上号——这正是 P3-R1 任务说明里强调"必须复用而不是重新推导"的原因。
 */
import type { CheckPoint } from '../model/checkpoint'
import type { SegmentStats } from './segments'

/**
 * 按 anchorIndex 升序排序的 CP 列表——和 `computeSegments` 内部构建
 * [起点, 各 CP, 终点] 边界数组时使用的排序规则完全一致。任何需要把
 * `segments[i]` 重新对应回某个 CP 的调用方都必须使用这份排序,否则会因为
 * 排序方式不一致而对错行。
 */
export function sortCpsByAnchor(cps: CheckPoint[]): CheckPoint[] {
  return [...cps].sort((a, b) => a.anchorIndex - b.anchorIndex)
}

/**
 * `segments[i]` 的终点边界是 `sortedCps[i]`(当 i < sortedCps.length 时),
 * 最后一段(终点段)没有对应 CP。这与 `computeSegments` 自身构建边界数组的
 * 方式完全一致(见该函数的文档注释)——`estimateArrivals` 需要一份和
 * `segments` 逐一对应的 cutoffsMs 数组,这里就是那份对应关系的唯一来源。
 *
 * 数组第 i 项为 `undefined` 的情形:i 是终点段(没有 CP 可关联)、对应 CP
 * 没有设置 cutoffTime,或 cutoffTime 无法解析为合法时间。
 */
export function alignCutoffsToSegments(segments: SegmentStats[], sortedCps: CheckPoint[]): (number | undefined)[] {
  return segments.map((_, i) => {
    if (i >= sortedCps.length) return undefined // 终点段,无关门时间
    const iso = sortedCps[i].cutoffTime
    if (!iso) return undefined
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? undefined : ms
  })
}
