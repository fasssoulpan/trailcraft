/**
 * datetime-local(浏览器 `<input type="datetime-local">` 给出的裸墙上时间)与
 * ISO 8601(含时区偏移)之间的双向转换。
 *
 * 约定(最初在 CpPanel.tsx 的关门时间输入框上定下):用户在界面上输入的永远
 * 是"当地墙上时间",转换时假定这台设备当前所在的时区就是用户想表达的时区。
 * 只要编辑始终发生在同一时区,来回编辑能精确回填同一个值;跨时区编辑同一
 * 个值(比如先在国内定好时间,出国后再打开同一个项目)才会看到偏移随之
 * 变化——这是该约定下的已知局限,不是 bug。
 *
 * 任务 18 新增的起跑时间(PacePanel.tsx / appStore.ts 的默认值)复用同一份
 * 实现,避免三处各写一份、时区处理细节(getTimezoneOffset 的符号与常见的
 * "东八区 = +08:00" 直觉相反)将来只改对一处。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 把一组本地时间字段拼成带当前设备时区偏移的 ISO 8601 字符串。 */
export function isoFromLocalParts(y: number, mo: number, d: number, h: number, mi: number): string {
  const local = new Date(y, mo - 1, d, h, mi, 0, 0)
  // getTimezoneOffset() 是"要加多少分钟才能从本地时间得到 UTC",符号和常见的
  // "东八区 = +08:00" 直觉相反,取负号才是通常书写 ISO 偏移量时的符号。
  const offsetMin = -local.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const offH = pad(Math.floor(abs / 60))
  const offM = pad(abs % 60)
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${sign}${offH}:${offM}`
}

export function isoToLocalInputValue(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function localInputValueToIso(value: string): string | undefined {
  if (!value) return undefined
  const [datePart, timePart] = value.split('T')
  if (!datePart || !timePart) return undefined
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = timePart.split(':').map(Number)
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return undefined
  return isoFromLocalParts(y, mo, d, h, mi)
}

/** 今天 hour:minute(本地时间)的 ISO 字符串,供 appStore 的起跑时间默认值使用。 */
export function defaultLocalTimeToday(hour: number, minute: number): string {
  const now = new Date()
  return isoFromLocalParts(now.getFullYear(), now.getMonth() + 1, now.getDate(), hour, minute)
}
