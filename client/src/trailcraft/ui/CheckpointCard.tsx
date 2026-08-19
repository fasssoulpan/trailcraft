import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { CheckPoint } from '../core/model/checkpoint'
import type { Track } from '../core/model/track'
// Type-only import, erased at compile time -- same pattern as
// HudOverlay.tsx/FlyControls.tsx for this exact type.
import type { FlythroughProgressInfo } from '../cesium/flythrough'
import { pickApproachingCheckpoint, buildCheckpointCardData } from './checkpointApproach'

export interface CheckpointCardHandle {
  /** Imperative per-frame update, called directly from the flythrough
   * engine's `onProgress` callback (see `FlyView.tsx`, same pattern as
   * `HudOverlay.tsx#HudOverlayHandle`) -- NOT via React props/state. Unlike
   * the HUD, this component DOES call `setState` here, but only when the
   * picked checkpoint actually changes (see the `visibleIdRef` guard
   * below) -- the common case (nothing to show, or the same card still
   * showing) is a pure computation with zero React work, and even the rare
   * case only re-renders this small subtree, never `FlyView`'s. */
  update(info: FlythroughProgressInfo): void
}

interface CheckpointCardProps {
  track: Track | undefined
  /** Every CP in the project, NOT pre-filtered to `track` -- this
   * component (via `pickApproachingCheckpoint`) does its own
   * `trackId`-based filtering, the same defensive convention
   * `cpEntities.ts`/`SegmentTable.tsx` follow, so a caller forgetting to
   * filter can't reintroduce P0's cross-track CP leakage bug. */
  cps: CheckPoint[]
}

/**
 * Checkpoint approach card (P1 §3.1/§3.4, milestone N4 commit 3): slides in
 * as the flythrough camera nears a checkpoint on the active track, shows
 * name / kind label / mileage / elevation / cutoff time (when set), and
 * dismisses once the camera has moved past. Rendered as a child of
 * `FlyOverlayLayer`.
 *
 * The actual "which checkpoint, if any" decision is
 * `checkpointApproach.ts#pickApproachingCheckpoint` -- a pure, unit-tested
 * function of the current mileage snapshot (see its own doc comment for
 * the approach/dismiss window constants and the "nearest wins, never a
 * pile" policy for closely-spaced checkpoints). This component is just the
 * per-frame caller plus the rendering.
 *
 * Follows `HudOverlay.tsx`'s imperative-`update()`-via-ref pattern for the
 * same reason: a naive `progress` prop would re-render this (and force
 * `FlyView` to re-diff its props) up to 60 times/second even though the
 * visible checkpoint typically changes a handful of times per flythrough.
 */
export const CheckpointCard = memo(
  forwardRef<CheckpointCardHandle, CheckpointCardProps>(function CheckpointCard({ track, cps }, ref) {
    const [visibleCp, setVisibleCp] = useState<CheckPoint | undefined>(undefined)

    const trackRef = useRef(track)
    trackRef.current = track
    const cpsRef = useRef(cps)
    cpsRef.current = cps
    // Mirrors `visibleCp`'s id outside React state so the imperative
    // update() below can cheaply check "did the answer change" without
    // waiting for a re-render to see its own previous setState (state
    // updates are not synchronously readable across ticks the way a ref
    // is), and so it never calls setState redundantly for a checkpoint
    // that's already showing.
    const visibleIdRef = useRef<string | undefined>(undefined)

    useImperativeHandle(
      ref,
      () => ({
        update(info) {
          const t = trackRef.current
          const next = t ? pickApproachingCheckpoint(cpsRef.current, t, info.mileageM) : undefined
          const nextId = next?.id
          if (nextId === visibleIdRef.current) return
          visibleIdRef.current = nextId
          setVisibleCp(next)
        },
      }),
      [],
    )

    // Re-evaluates immediately on mount / track switch / cps edit, instead
    // of showing a stale (possibly wrong-track) card until the next
    // playback tick -- same reasoning as HudOverlay.tsx's mirror effect.
    // Evaluated at mileage 0 (a fresh flythrough always starts there;
    // seeking away from 0 on the very next tick corrects this via the
    // imperative path above the same way any other seek does).
    useEffect(() => {
      const next = track ? pickApproachingCheckpoint(cps, track, 0) : undefined
      visibleIdRef.current = next?.id
      setVisibleCp(next)
    }, [track, cps])

    if (!track || !visibleCp) return null

    // Same formatting checkpointApproach.ts#buildCheckpointCardData feeds
    // cesium/recorder.ts's video compositor (milestone N5) -- see that
    // function's own doc comment for why this must not be reimplemented
    // here instead of called.
    const card = buildCheckpointCardData(visibleCp, track)

    return (
      // `key` on the checkpoint's own id: switching to a DIFFERENT
      // checkpoint mounts a brand-new DOM node (rather than patching the
      // old one's text in place), which is what lets the CSS slide-in
      // animation (App.css's `.checkpoint-card` `@keyframes`) replay for
      // every new checkpoint instead of only the very first one.
      <div key={card.id} className="checkpoint-card" style={{ borderLeftColor: card.color }} role="status">
        {
          // 方案 V2.1 §5.5「CP 卡片…实景照片淡入」——`key={card.photoUrl}`
          // 让"这张卡片显示的是哪张照片"参与 React 的 key 比较,切换到下一个
          // 带照片的 CP 时 <img> 会被当成新节点重新挂载,`checkpoint-card-photo-
          // fade-in` 这条 CSS 动画因此每次都会重播,而不是只在整张卡片第一次
          // 出现时播放一次(卡片本身的 key 是 card.id,只保证卡片级别的滑入
          // 动画每次重播,不覆盖卡片内部照片的独立淡入时机)。
          card.photoUrl && (
            <img key={card.photoUrl} className="checkpoint-card__photo" src={card.photoUrl} alt="" />
          )
        }
        <div className="checkpoint-card__kind" style={{ color: card.color }}>
          {card.kindLabel}
        </div>
        <div className="checkpoint-card__name">{card.name}</div>
        <div className="checkpoint-card__meta">
          {card.mileageKm !== undefined && <span>{card.mileageKm.toFixed(2)} km</span>}
          {card.eleM !== undefined && <span>{Math.round(card.eleM)} m</span>}
          {card.cutoff !== undefined && <span className="checkpoint-card__cutoff">关门 {card.cutoff}</span>}
        </div>
      </div>
    )
  }),
)
