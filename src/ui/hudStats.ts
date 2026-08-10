/**
 * Pure data layer for the flythrough HUD (P1 §3.1/§3.4, milestone N4
 * commit 2) -- no React, no DOM, so it's unit-testable with plain numbers
 * exactly like `cesium/cameraPath.ts` is for the camera itself.
 * `src/ui/HudOverlay.tsx` is the thin "untestable in Node" half that owns
 * refs/DOM and calls into this module every frame.
 *
 * `getHudTrackStats` builds the two things the HUD needs but can't afford
 * to recompute every frame -- the running-gain/loss prefix arrays
 * (`core/stats/runningStats.ts`) and a decimated `ProfileData` for the
 * gradient lookup -- ONCE per (Track, statsOptions) pair, cached in a
 * `WeakMap` keyed on the immutable `Track` object, mirroring
 * `cesium/trackEntities.ts`'s `geometryCache` convention (see that file's
 * doc comment for why `WeakMap<Track, ...>` is the right cache key: a
 * toolbox edit or CP change produces a brand-new `Track`/settings object,
 * so identity change is exactly the right invalidation signal, and nothing
 * needs to be told to bust the cache explicitly).
 */
import type { Track } from '../core/model/track'
import type { StatsOptions } from '../core/stats/segments'
import { buildRunningGainLoss, gradientAt, GRADIENT_WINDOW } from '../core/stats/runningStats'
import { buildProfileData, nearestSamplePos, type ProfileData } from '../profile/profileRender'

// Same defaults as core/stats/segments.ts's DEFAULT_THRESHOLD/
// DEFAULT_SMOOTH_WINDOW (not imported from there since that module doesn't
// export them) -- appStore's statsOptions is always fully populated in
// practice (see appStore.ts's DEFAULT_STATS_OPTIONS), so these only matter
// for a caller that hands in a bare `{}`, e.g. a test.
const DEFAULT_THRESHOLD = 5
const DEFAULT_SMOOTH_WINDOW = 5

export interface HudTrackStats {
  /** gain[i]/loss[i] = cumulative ascent/descent (metres) from the start of
   * the track through full-precision point i. Empty when the track has no
   * elevation column. */
  gain: Float64Array
  loss: Float64Array
  /** Decimated profile data, identical to what ProfileCanvas.tsx builds for
   * its own chart (same MAX_PROFILE_POINTS default) -- the HUD's gradient
   * reading is computed from THIS, via `nearestSamplePos`/`gradientAt`,
   * specifically so it agrees with the profile's own hover readout at the
   * same track position (see this module's file comment and
   * `core/stats/runningStats.ts#gradientAt`'s doc comment). `undefined`
   * when the track has no elevation column or no cumDist yet. */
  profile: ProfileData | undefined
}

interface CacheEntry {
  /** `${threshold}:${smoothWindow}` -- recomputed whenever statsOptions
   * changes, even though the Track object itself didn't, so the HUD tracks
   * the same calibration the segment table uses. */
  key: string
  stats: HudTrackStats
}

const cache = new WeakMap<Track, CacheEntry>()

function statsKey(opts: StatsOptions): string {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const smoothWindow = opts.smoothWindow ?? DEFAULT_SMOOTH_WINDOW
  return `${threshold}:${smoothWindow}`
}

/** Builds (or returns the cached) `HudTrackStats` for `track` under `opts`.
 * O(n) on a cache miss (new track, or `opts` changed since the last call
 * for this track); O(1) otherwise -- the whole point, since this is called
 * from the flythrough engine's per-frame `onProgress` callback (see
 * `HudOverlay.tsx`). */
export function getHudTrackStats(track: Track, opts: StatsOptions): HudTrackStats {
  const key = statsKey(opts)
  const cached = cache.get(track)
  if (cached && cached.key === key) return cached.stats

  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const smoothWindow = opts.smoothWindow ?? DEFAULT_SMOOTH_WINDOW
  const { gain, loss } = buildRunningGainLoss(track.points.ele, threshold, smoothWindow)
  const profile = buildProfileData(track)
  const stats: HudTrackStats = { gain, loss, profile }
  cache.set(track, { key, stats })
  return stats
}

export interface HudReadout {
  mileageKm: number
  /** `undefined` when the track has no elevation column, or the specific
   * point has no recorded reading (NaN). */
  elevationM: number | undefined
  /** Cumulative ascent from the start through this point; `undefined` under
   * the same conditions as `elevationM`. */
  ascentM: number | undefined
  /** `undefined` when there isn't enough finite elevation data around this
   * point to compute a meaningful slope -- see `gradientAt`'s doc comment. */
  gradientPct: number | undefined
  /** `undefined` when the track has no `hr` column, or this point's reading
   * is the "no data" sentinel (0 -- see `core/model/track.ts`'s `hr` field
   * doc comment). */
  heartRateBpm: number | undefined
}

const EMPTY_READOUT: HudReadout = {
  mileageKm: 0,
  elevationM: undefined,
  ascentM: undefined,
  gradientPct: undefined,
  heartRateBpm: undefined,
}

/**
 * Computes everything the HUD displays at a single full-precision point
 * index. Pure function of `(track, stats, pointIndex)` -- called fresh
 * every frame by `HudOverlay.tsx`, but cheap: everything expensive already
 * happened once in `getHudTrackStats`.
 *
 * `pointIndex` is clamped into the track's valid range rather than
 * validated/thrown on -- the flythrough engine's reported index is already
 * supposed to stay in range (see `cesium/cameraPath.ts#fullPrecisionIndex`),
 * but this is cheap insurance against an off-by-one at a track boundary
 * ever crashing the HUD instead of just clamping visually.
 */
export function computeHudReadout(track: Track, stats: HudTrackStats, pointIndex: number): HudReadout {
  const n = track.points.lon.length
  if (n === 0) return EMPTY_READOUT
  const idx = Math.min(Math.max(Math.round(pointIndex), 0), n - 1)

  const cumDist = track.points.cumDist
  const mileageKm = cumDist && cumDist.length > 0 ? cumDist[idx] / 1000 : 0

  const rawEle = track.points.ele
  const elevationM = rawEle && Number.isFinite(rawEle[idx]) ? rawEle[idx] : undefined

  const ascentM = stats.gain.length > 0 ? stats.gain[Math.min(idx, stats.gain.length - 1)] : undefined

  let gradientPct: number | undefined
  if (stats.profile && stats.profile.idx.length > 0) {
    const pos = nearestSamplePos(stats.profile.idx, idx)
    gradientPct = gradientAt(stats.profile.ele, stats.profile.dist, pos, GRADIENT_WINDOW)
  }

  const hr = track.points.hr
  const heartRateBpm = hr && hr[idx] > 0 ? hr[idx] : undefined

  return { mileageKm, elevationM, ascentM, gradientPct, heartRateBpm }
}
