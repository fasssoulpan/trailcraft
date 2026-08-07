export type CpKind = 'cp' | 'aid' | 'gear' | 'danger' | 'quit'

/** 五种 CP 类型的中文展示名,CpPanel / MapView 的创建表单共用同一份映射。 */
export const CP_KIND_LABELS: Record<CpKind, string> = {
  cp: 'CP 打卡点',
  aid: '补给站',
  gear: '强装检查',
  danger: '危险路段',
  quit: '退赛点',
}

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
