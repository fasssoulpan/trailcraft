export type CpKind =
  | 'marker'
  | 'water'
  | 'aid'
  | 'danger'
  | 'toilet'
  | 'shelter'
  | 'junction'
  | 'camp'
  | 'change'
  // Retained only to render already-saved projects created before the
  // simplified marker palette; no new UI or auto-import rule selects them.
  | 'gear'
  | 'fishing'
  | 'obstacle'
  | 'structure'
  | 'cp'
  // Kept for backwards compatibility with saved TrailCraft projects.
  | 'quit'
  | 'landmark'

/** 六种 CP 类型的中文展示名,CpPanel / MapView 的创建表单共用同一份映射。 */
export const CP_KIND_LABELS: Record<CpKind, string> = {
  marker: '标记点',
  water: '水源',
  aid: '补给站',
  danger: '危险路段',
  toilet: '厕所',
  shelter: '避难所',
  junction: '岔路',
  camp: '营地',
  change: '换装点',
  gear: '穿装点（旧版）',
  fishing: '渔获（旧版）',
  obstacle: '障碍（旧版）',
  structure: '结构（旧版）',
  cp: 'CP 签到（旧版）',
  quit: '退赛点（旧版）',
  landmark: '重要地标（旧版）',
}

/** Current marker palette shown to users. Legacy persisted values remain in
 * `CpKind` above so older project files still render, but are not offered as
 * new choices in the high-level icon picker. */
export const CP_KIND_OPTIONS: CpKind[] = [
  'marker', 'water', 'aid', 'danger', 'shelter', 'junction',
  'camp', 'change',
]

/** Compact, font-safe monograms used inside 2D markers and before 3D labels.
 * They encode the same categories as the icon chooser without depending on a
 * remote sprite sheet, so offline/local-first route projects remain usable. */
export const CP_KIND_MARKS: Record<CpKind, string> = {
  marker: '•',
  water: '≈',
  aid: '+',
  danger: '!',
  toilet: 'WC',
  shelter: '⌂',
  junction: 'Y',
  camp: '△',
  change: '⇄',
  gear: '◉',
  fishing: '⌇',
  obstacle: '×',
  structure: '▥',
  cp: 'CP',
  quit: '↗',
  landmark: '◆',
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
  marker: '#2563eb',
  water: '#0891b2',
  aid: '#16a34a',
  danger: '#dc2626',
  toilet: '#475569',
  shelter: '#7c3aed',
  junction: '#d97706',
  camp: '#a16207',
  change: '#c2410c',
  gear: '#ca8a04',
  fishing: '#0f766e',
  obstacle: '#b91c1c',
  structure: '#64748b',
  cp: '#1d4ed8',
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
