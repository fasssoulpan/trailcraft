/**
 * 紧凑时刻/时长格式化——路书系列输出(Excel 节点明细、配速卡)和
 * `SegmentTable.tsx` 共用同一份实现,而不是各自内联一份几乎相同的代码
 * (原先 `SegmentTable.tsx` 就是这么做的)。`src/ui/perfFormat.ts` 已有的
 * `formatDurationHM` 面向长文本场景("3小时25分"),这里的
 * `formatDurationCompactHM` 面向表格/卡片这种寸土寸金的场景("3:25")——
 * 两者服务不同的展示密度,不是重复实现同一件事。
 */

/** h:mm,用于逐段耗时、全程合计耗时这类紧凑表格单元格。 */
export function formatDurationCompactHM(sec: number): string {
  if (!Number.isFinite(sec)) return '--'
  const totalMin = Math.round(sec / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/** HH:mm(本地时区),用于预计到达/关门时间这类"某个时刻"的展示。 */
export function formatClockHM(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ±h:mm 的关门余量展示。`undefined`/非有限值(含 estimateArrivals 在没有
 * 关门时间时返回的 Infinity)一律显示占位符,不伪造一个具体数字。 */
export function formatMarginCompact(marginSec: number | undefined): string {
  if (marginSec === undefined || !Number.isFinite(marginSec)) return '--'
  const sign = marginSec < 0 ? '-' : '+'
  return `${sign}${formatDurationCompactHM(Math.abs(marginSec))}`
}
