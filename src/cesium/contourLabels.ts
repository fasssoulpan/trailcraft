/**
 * Pure placement logic for the contour elevation labels, kept free of any
 * `cesium` import for the same reason `contourSpacing.ts` and
 * `contourPreset.ts` are: it is the branchy part, and testing it needs
 * neither a `Viewer` nor a WebGL context. `contours.ts` is the untestable
 * half that samples a real terrain grid and turns these placements into
 * Cesium labels.
 *
 * ---- Why any of this is necessary ----
 * The contour lines themselves are drawn by Cesium's built-in
 * `ElevationContour` fabric material, which is a *fragment shader*: it tints
 * pixels whose interpolated elevation lands near a multiple of the spacing.
 * There is no polyline anywhere in memory, so there is nothing to attach a
 * label to. To put numbers on the lines we have to find the lines ourselves.
 *
 * ---- How ----
 * Given a regular grid of sampled terrain heights, walk every horizontal and
 * vertical edge between adjacent samples and linearly interpolate where the
 * height crosses each multiple of `spacingM`. Those crossing points lie on a
 * contour by construction, and the value to print is exact (it is the level,
 * not a resampled height).
 *
 * Both directions are scanned on purpose. A contour running east-west shows
 * no crossing along an east-west row (height is ~constant along it) and is
 * only found by scanning north-south, and vice versa; scanning one axis only
 * would silently drop every contour parallel to it.
 *
 * ---- Thinning ----
 * A dense grid produces thousands of crossings, which as labels would be an
 * unreadable smear. Two conventions from paper topographic maps do the
 * culling:
 *   - Only *index* contours (every `CONTOUR_INDEX_EVERY`-th level) are
 *     labelled when there are more candidates than room for. This is what
 *     printed maps do -- you label 1200/1250 and let the four lines between
 *     them be read off by counting.
 *   - Accepted labels must be at least `minSeparation` apart, greedily.
 *
 * Everything here is deterministic for a given input: candidates are
 * generated in a fixed scan order and thinned by a stable priority, so the
 * same view produces the same labels rather than a set that shimmers as the
 * camera micro-moves.
 */

/** Label every 5th contour, the usual index-contour interval on paper maps. */
export const CONTOUR_INDEX_EVERY = 5

/** Hard cap on labels in view -- past this it reads as clutter, not data. */
export const CONTOUR_LABEL_MAX = 36

/**
 * Minimum gap between two labels, as a fraction of the view rectangle's
 * larger side. Deliberately generous: labels compete with the track, the
 * checkpoints and the imagery underneath.
 */
export const CONTOUR_LABEL_MIN_SEPARATION_FRACTION = 0.11

export interface ContourHeightGrid {
  /** Row-major, `rows * cols` samples; NaN where no terrain tile was resident. */
  heights: Float64Array
  rows: number
  cols: number
  /** Geographic bounds, degrees. `north`/`east` are the last row/column. */
  west: number
  south: number
  east: number
  north: number
}

export interface ContourLabelPlacement {
  lon: number
  lat: number
  /** The contour level itself, in metres -- exact, not a resampled height. */
  elevationM: number
  /** True for an index contour, which is drawn heavier. */
  index: boolean
}

interface Candidate extends ContourLabelPlacement {
  /** Scan order, used only to keep thinning deterministic. */
  seq: number
}

/**
 * Levels strictly between two sampled heights, as level indices (so that
 * `level * spacingM` is the elevation). Returns an empty range when the two
 * samples straddle nothing, which is the overwhelmingly common case.
 */
function levelRange(a: number, b: number, spacingM: number): { from: number; to: number } {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  // `floor(hi/s)` rather than `ceil`, and `+1` on the low end, so a sample
  // sitting exactly on a level is attributed to one edge only instead of
  // being emitted twice by the two edges that share it.
  return { from: Math.floor(lo / spacingM) + 1, to: Math.floor(hi / spacingM) }
}

export function contourLabelPlacements(
  grid: ContourHeightGrid,
  spacingM: number,
  options: { maxLabels?: number; indexEvery?: number } = {},
): ContourLabelPlacement[] {
  const maxLabels = options.maxLabels ?? CONTOUR_LABEL_MAX
  const indexEvery = options.indexEvery ?? CONTOUR_INDEX_EVERY
  const { heights, rows, cols, west, south, east, north } = grid

  if (!(spacingM > 0) || rows < 2 || cols < 2 || maxLabels <= 0) return []
  if (!(east > west) || !(north > south)) return []

  const lonStep = (east - west) / (cols - 1)
  const latStep = (north - south) / (rows - 1)
  const candidates: Candidate[] = []
  let seq = 0

  function emit(level: number, lon: number, lat: number): void {
    candidates.push({
      lon,
      lat,
      elevationM: level * spacingM,
      index: level % indexEvery === 0,
      seq: seq++,
    })
  }

  for (let r = 0; r < rows; r++) {
    const lat = south + r * latStep
    for (let c = 0; c < cols; c++) {
      const h = heights[r * cols + c]
      if (!Number.isFinite(h)) continue
      const lon = west + c * lonStep

      // East neighbour.
      if (c + 1 < cols) {
        const hE = heights[r * cols + c + 1]
        if (Number.isFinite(hE) && hE !== h) {
          const { from, to } = levelRange(h, hE, spacingM)
          for (let level = from; level <= to; level++) {
            const t = (level * spacingM - h) / (hE - h)
            emit(level, lon + t * lonStep, lat)
          }
        }
      }

      // North neighbour.
      if (r + 1 < rows) {
        const hN = heights[(r + 1) * cols + c]
        if (Number.isFinite(hN) && hN !== h) {
          const { from, to } = levelRange(h, hN, spacingM)
          for (let level = from; level <= to; level++) {
            const t = (level * spacingM - h) / (hN - h)
            emit(level, lon, lat + t * latStep)
          }
        }
      }
    }
  }

  if (candidates.length === 0) return []

  const minSeparation =
    Math.max(east - west, north - south) * CONTOUR_LABEL_MIN_SEPARATION_FRACTION

  // Index contours first, then original scan order. `sort` is stable in
  // every engine this ships to, so equal-priority candidates keep their scan
  // order and the result is reproducible for a given view.
  const ordered = [...candidates].sort((a, b) => Number(b.index) - Number(a.index) || a.seq - b.seq)

  // Longitude degrees shrink towards the poles; comparing raw degrees would
  // make the separation test progressively too lax in latitude terms at high
  // latitude. Scale by cos(lat) so the gap is roughly isotropic on the ground.
  const lonScale = Math.cos(((north + south) / 2) * (Math.PI / 180)) || 1
  const accepted: ContourLabelPlacement[] = []

  for (const cand of ordered) {
    if (accepted.length >= maxLabels) break
    const tooClose = accepted.some((a) => {
      const dLon = (a.lon - cand.lon) * lonScale
      const dLat = a.lat - cand.lat
      return Math.hypot(dLon, dLat) < minSeparation
    })
    if (!tooClose) accepted.push({ lon: cand.lon, lat: cand.lat, elevationM: cand.elevationM, index: cand.index })
  }

  return accepted
}
