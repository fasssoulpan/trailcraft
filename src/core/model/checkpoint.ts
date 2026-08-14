export type CpKind = 'cp' | 'aid' | 'gear' | 'danger' | 'quit' | 'landmark'

/** 六种 CP 类型的中文展示名,CpPanel / MapView 的创建表单共用同一份映射。 */
export const CP_KIND_LABELS: Record<CpKind, string> = {
  cp: 'CP 打卡点',
  aid: '补给站',
  gear: '强装检查',
  danger: '危险路段',
  quit: '退赛点',
  landmark: '重要地标',
}

/**
 * Distinct per-kind colour so CPs stay visually distinguishable at a glance
 * (danger/quit points in particular should read as "different" from a plain
 * CP even before you read the label). Lives here (not `map/trackLayer.ts`,
 * where it originated) precisely so it's reachable from anything that must
 * NOT statically pull in `maplibre-gl` -- `src/cesium/cpEntities.ts` (the 3D
 * pin colour) and `src/ui/CheckpointCard.tsx` (N4's flythrough card accent)
 * both need the exact same values a checkpoint uses in 规划 mode, and the
 * latter is reached from `FlyView.tsx`'s static import graph, not behind the
 * `cesium`/map dynamic-import boundary -- importing `map/trackLayer.ts`
 * (which imports `maplibre-gl` at module scope) from there would have
 * dragged the whole MapLibre bundle into the main chunk. `map/trackLayer.ts`
 * re-exports this constant for its own existing call sites.
 */
export const CP_KIND_COLORS: Record<CpKind, string> = {
  cp: '#1d4ed8',
  aid: '#16a34a',
  gear: '#ca8a04',
  danger: '#dc2626',
  quit: '#6b7280',
  // Purple: distinct from every other kind above and from TRACK_PALETTE (see
  // core/model/trackStyle.ts), so a landmark never reads as a track line or
  // as another kind of checkpoint.
  landmark: '#9333ea',
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
