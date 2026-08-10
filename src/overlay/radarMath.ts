/**
 * Pure "range ladder" maths for the distance radar overlay (P1 §3.7,
 * milestone N6 commit 3), deliberately free of any Canvas/Cesium/MapLibre
 * import -- same split as `cesium/terrainSelection.ts` and
 * `cesium/contourSpacing.ts`: the *decision* (which ring distances to draw,
 * given how many metres a screen pixel currently represents) is pure and
 * worth testing in isolation; `overlay/radar.ts` is the untestable-in-Node
 * half that actually paints these onto a `CanvasRenderingContext2D`.
 *
 * "Nice numbers" ladder in a 1/2.5/5 pattern per decade (…10, 25, 50, 100,
 * 250, 500, 1000, 2500, 5000, 10000…) -- the classic map-scale-bar
 * progression, matching the brief's own example (100 m / 250 m / 500 m /
 * 1 km / 2.5 km / 5 km / 10 km …) as a subset starting at the 100 m rung.
 * Generated programmatically across decades rather than hand-listed so it
 * has no upper/lower bound baked in as a literal array -- extreme zoom
 * levels (either a flythrough camera metres off the ground, or an orbit
 * pulled back to see an entire province) still land on a ladder rung
 * instead of falling off either end.
 */

const LADDER_DECADE_MULTIPLIERS = [1, 2.5, 5]
export const RADAR_MIN_STEP_M = 10
const RADAR_MAX_STEP_M = 1_000_000

function buildLadder(): number[] {
  const steps: number[] = []
  for (let decade = 1; decade <= RADAR_MAX_STEP_M; decade *= 10) {
    for (const m of LADDER_DECADE_MULTIPLIERS) {
      const v = decade * m
      if (v >= RADAR_MIN_STEP_M && v <= RADAR_MAX_STEP_M) steps.push(v)
    }
  }
  return steps
}

/** Ascending "nice" ring-distance rungs, in metres. */
export const RADAR_STEP_LADDER_M: readonly number[] = buildLadder()

/** How many concentric rings the radar draws by default. */
export const DEFAULT_RADAR_RING_COUNT = 4

export interface RadarRing {
  distanceM: number
  radiusPx: number
  label: string
}

export interface RadarRingSet {
  /** The ladder rung actually chosen -- rings are this value times 1, 2, 3, … */
  stepM: number
  rings: RadarRing[]
}

/**
 * Picks the smallest ladder rung that is `>= desiredStepM`, clamping to the
 * ladder's own ends rather than ever returning something off-ladder (a
 * huge/tiny/NaN `desiredStepM` still gets a real, drawable step back).
 */
function pickLadderStep(desiredStepM: number): number {
  const ladder = RADAR_STEP_LADDER_M
  if (!Number.isFinite(desiredStepM) || desiredStepM <= ladder[0]) return ladder[0]
  for (const step of ladder) {
    if (step >= desiredStepM) return step
  }
  return ladder[ladder.length - 1]
}

function trimTrailingZeros(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '')
}

/** "850 m" below 1 km, "2.5 km" at/above -- matches the ladder's own unit switch. */
export function formatRadarDistance(distanceM: number): string {
  if (!Number.isFinite(distanceM) || distanceM < 0) return '--'
  if (distanceM >= 1000) return `${trimTrailingZeros(distanceM / 1000)} km`
  return `${Math.round(distanceM)} m`
}

/**
 * Chooses a set of concentric ring distances for a radar whose maximum
 * visible radius is `maxRadiusPx` screen pixels, given the current
 * ground-scale `metersPerPixel`. Targets `ringCount` rings spanning roughly
 * the full radius (so the outermost ring lands near, not far past,
 * `maxRadiusPx`), then snaps the spacing to the nearest ladder rung so the
 * labelled values always read as "nice" round numbers rather than an
 * arbitrary fraction of the viewport.
 *
 * Degenerate inputs (non-finite/zero/negative `metersPerPixel` or
 * `maxRadiusPx`, e.g. a viewer whose camera height hasn't resolved yet, or
 * a not-yet-laid-out zero-size overlay canvas) are substituted with safe
 * positive fallbacks rather than propagating into `distanceM`/`radiusPx` as
 * NaN or Infinity -- this function always returns a real, drawable ring set.
 *
 * Because every ring's distance is `stepM * i` for a strictly increasing
 * integer `i` and a strictly positive `stepM`, ring distances (and
 * therefore radii, at a fixed `metersPerPixel`) are always strictly
 * increasing -- rings can never coincide or overlap.
 */
export function chooseRadarRings(
  metersPerPixel: number,
  maxRadiusPx: number,
  ringCount: number = DEFAULT_RADAR_RING_COUNT,
): RadarRingSet {
  const safeMpp = Number.isFinite(metersPerPixel) && metersPerPixel > 0 ? metersPerPixel : 1
  const safeMaxRadiusPx = Number.isFinite(maxRadiusPx) && maxRadiusPx > 0 ? maxRadiusPx : 1
  const safeCount = Math.max(1, Math.floor(Number.isFinite(ringCount) ? ringCount : DEFAULT_RADAR_RING_COUNT))

  const maxRangeM = safeMpp * safeMaxRadiusPx
  const desiredStepM = maxRangeM / safeCount
  const stepM = pickLadderStep(desiredStepM)

  const rings: RadarRing[] = []
  for (let i = 1; i <= safeCount; i++) {
    const distanceM = stepM * i
    rings.push({ distanceM, radiusPx: distanceM / safeMpp, label: formatRadarDistance(distanceM) })
  }
  return { stepM, rings }
}
