/**
 * Playback speed ladder for the flythrough, shared by the UI and the engine.
 *
 * These lived in two places before: `FlyControls.tsx` offered up to 500x while
 * `FlythroughEngine.setSpeed` silently clamped to 20x, so the four fastest
 * buttons all behaved identically as 20x and the "estimated duration" readout
 * beside them was wrong by up to 25x. Having one module own both the ladder
 * and its bounds makes that divergence impossible to reintroduce.
 *
 * Why the ladder runs so far past 20x: 1x is the track's own recorded pace
 * (see `cameraPath.ts#averageSpeedMps`), so playback duration is
 * recorded-duration / multiplier. A 14 km outing replays in ~5 min at 20x,
 * but a 172 km race route -- whose timeline is synthesised at 2.5 m/s when the
 * file has no timestamps, giving ~19 h -- still needs ~57 min at 20x. 500x
 * brings that to a bit over two minutes.
 *
 * Cesium is deliberately not imported here so the UI can use these without
 * pulling the 3D engine into the main bundle.
 */
export const SPEED_OPTIONS: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500]

export const MIN_SPEED = SPEED_OPTIONS[0]
export const MAX_SPEED = SPEED_OPTIONS[SPEED_OPTIONS.length - 1]
export const DEFAULT_SPEED = 1

export function clampSpeed(multiplier: number): number {
  if (!Number.isFinite(multiplier)) return DEFAULT_SPEED
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, multiplier))
}
