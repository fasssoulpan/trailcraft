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
  /**
   * 所属轨迹的 id(Track.id)。CP 从来不是"漂浮"在应用里的——它锚定的
   * anchorIndex 只有相对某一条具体轨迹的 points 数组才有意义。这是必填而非
   * 可选字段:一旦允许缺失,任何忘记过滤的展示/计算路径都会默默把它当成
   * "属于当前激活轨迹",重新引入本字段本要修复的那类静默数据错位。
   */
  trackId: string
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
