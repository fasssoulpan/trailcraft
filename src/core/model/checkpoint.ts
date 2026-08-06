export type CpKind = 'cp' | 'aid' | 'gear' | 'danger' | 'quit'

export interface CheckPoint {
  id: string
  name: string
  kind: CpKind
  /** 锚定的全精度轨迹点索引 */
  anchorIndex: number
  /** 用户点击的原始位置(锚定前) */
  clickLngLat?: [number, number]
  /** 关门时间 ISO 8601 含时区,如 2026-08-06T14:00:00+08:00 */
  cutoffTime?: string
  photoUrl?: string
}
