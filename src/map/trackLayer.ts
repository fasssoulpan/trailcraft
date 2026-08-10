import { GeoJSONSource, LngLatBounds, Marker, type Map as MapLibreMap } from 'maplibre-gl'
import type { Feature, LineString } from 'geojson'
import type { Track } from '../core/model/track'
import type { CheckPoint } from '../core/model/checkpoint'
import { CP_KIND_COLORS } from '../core/model/checkpoint'
import type { HoverState } from '../state/appStore'
import { decimateIndices } from '../core/toolbox/decimate'
import { TRACK_PALETTE, DEFAULT_LINE_WIDTH } from '../core/model/trackStyle'

/** MapLibre only ever draws this many vertices per track; real tracks (up to
 * ~330k points) are decimated down to this for rendering. Hover/lookup still
 * resolves to full-precision indices via `RenderCopy.idx`. */
export const RENDER_MAX = 4000

export interface RenderCopy {
  /** idx[i] = full-precision point index that render-copy position i maps back to */
  idx: Uint32Array
  /** decimated [lon, lat] pairs, same length/order as idx */
  coords: [number, number][]
}

// Tracks are immutable once created (see core/model/track.ts), and renderCopy
// is called on every hover/mousemove event, so we memoize per-track. A
// WeakMap lets removed tracks (and their render copies) get garbage
// collected once nothing else references the Track object.
const renderCopyCache = new WeakMap<Track, RenderCopy>()

export function renderCopy(t: Track): RenderCopy {
  const cached = renderCopyCache.get(t)
  if (cached) return cached
  const { lon, lat } = t.points
  const idx = decimateIndices(lon.length, RENDER_MAX)
  const coords: [number, number][] = new Array(idx.length)
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i]
    coords[i] = [lon[p], lat[p]]
  }
  const result: RenderCopy = { idx, coords }
  renderCopyCache.set(t, result)
  return result
}

function layerIdFor(trackId: string): string {
  return `trk-${trackId}`
}

function trackToFeature(t: Track): Feature<LineString> {
  return {
    type: 'Feature',
    properties: { id: t.id },
    geometry: { type: 'LineString', coordinates: renderCopy(t).coords },
  }
}

// Tracks previously synced onto a given map instance, so we can detect
// removals (tracks present before but absent from the latest `tracks` list)
// and tell newly-added tracks apart from ones we've already drawn (so we
// only fit bounds to genuinely new tracks, not on every re-render).
const knownTrackIds = new WeakMap<MapLibreMap, Set<string>>()

// The most recently added track that still needs its camera fit, keyed per
// map instance. Set whenever a genuinely new track is synced in; cleared
// once `tryPendingFit` successfully places the camera on it. This is
// deliberately separate from `knownTrackIds` (which tracks layer
// add/remove) -- a track can be fully drawn (source+layer present) while
// its fit is still pending, because the container had zero usable area at
// sync time (see `tryPendingFit`'s doc comment for why that happens and why
// a plain "fit once, on add" can't be the whole story).
const pendingFit = new WeakMap<MapLibreMap, string>()

/** Minimum container dimension (css px) below which a camera fit isn't
 * attempted at all -- anything smaller and the derived zoom/center math
 * degenerates (division by ~0). */
const MIN_USABLE_PX = 2

const FIT_PADDING = 40

function containerSize(map: MapLibreMap): { width: number; height: number } {
  const el = map.getContainer()
  return { width: el.clientWidth, height: el.clientHeight }
}

function canvasUsable(map: MapLibreMap): boolean {
  const { width, height } = containerSize(map)
  return width >= MIN_USABLE_PX && height >= MIN_USABLE_PX
}

function boundsFromCoords(coords: [number, number][]): LngLatBounds | undefined {
  if (coords.length === 0) return undefined
  return coords.reduce((b, c) => b.extend(c), new LngLatBounds(coords[0], coords[0]))
}

/**
 * Zoom level (Web Mercator / MapLibre convention, 0 = whole world in one
 * 256px tile) at which `bounds` just fits inside a `width` x `height`
 * viewport, ignoring padding. Only used as a fallback when there isn't
 * enough room to honour normal padding (see `fitCamera`) -- this is the
 * same "fraction of the world the bounds span, in each axis" calculation
 * MapLibre's own `cameraForBounds` does internally, reimplemented here
 * because we need to call it in the exact case where MapLibre's own
 * `fitBounds` has already been ruled out.
 *
 * Exported (only) for `tests/map/zoomForBounds.test.ts` -- this is pure
 * maths with no MapLibre map instance involved, and it's precisely the
 * fallback that rescues the "track imported into a too-small container"
 * failure case, so it's worth testing directly rather than only indirectly
 * through `fitCamera`/`syncTrackLayers`.
 *
 * Degenerate inputs are always clamped to a finite [0, 20] zoom rather than
 * producing NaN/Infinity: a zero-extent bounds (a single-point track) makes
 * `latFraction`/`lngFraction` compute to exactly 0, and `|| 1e-9` below
 * substitutes a tiny non-zero divisor so the result is a very large (but
 * finite) zoom that then clamps to the max, 20 -- see the test file for the
 * exact assertion.
 */
export function zoomForBounds(bounds: LngLatBounds, width: number, height: number): number {
  const WORLD_PX = 256
  const latRad = (lat: number) => (lat * Math.PI) / 180
  const sn = Math.sin(latRad(bounds.getNorth()))
  const ss = Math.sin(latRad(bounds.getSouth()))
  const latFraction = (Math.log((1 + sn) / (1 - sn)) - Math.log((1 + ss) / (1 - ss))) / (2 * Math.PI)
  const lngDiffRaw = bounds.getEast() - bounds.getWest()
  const lngFraction = (lngDiffRaw < 0 ? lngDiffRaw + 360 : lngDiffRaw) / 360

  const latZoom = Math.log2(height / WORLD_PX / (Math.abs(latFraction) || 1e-9))
  const lngZoom = Math.log2(width / WORLD_PX / (Math.abs(lngFraction) || 1e-9))
  return Math.max(0, Math.min(20, Math.min(latZoom, lngZoom)))
}

/**
 * Fit the map's camera to `bounds`, robust to the container being too small
 * for `fitBounds`' padding to make sense.
 *
 * MapLibre's `fitBounds` silently leaves the camera untouched (logs "Map
 * cannot fit within canvas" and returns) when the requested padding would
 * consume more space than the container actually has -- this is exactly
 * what happens right after mount, before the flex/CSS layout has given the
 * map container real dimensions, and it is indistinguishable from success
 * unless the caller checks first. When that's the case here, fall back to a
 * direct `jumpTo` with a center/zoom computed straight from the bounds
 * (ignoring padding entirely) so the camera still ends up on the track
 * instead of silently staying at the default view.
 */
function fitCamera(map: MapLibreMap, bounds: LngLatBounds): void {
  const { width, height } = containerSize(map)
  const availW = width - FIT_PADDING * 2
  const availH = height - FIT_PADDING * 2
  if (availW > 0 && availH > 0) {
    map.fitBounds(bounds, { padding: FIT_PADDING, duration: 300 })
    return
  }
  const center = bounds.getCenter()
  const zoom = zoomForBounds(bounds, Math.max(width, 1), Math.max(height, 1))
  map.jumpTo({ center, zoom })
}

/**
 * Attempts to fit the camera onto whichever track is currently owed a fit
 * (see `pendingFit`), but only once the map container has a usable size.
 * No-ops if there's nothing pending, or the container is still too small
 * (e.g. a 60x0px container mid-layout, or a resizable pane dragged below
 * its minimum) -- the pending marker is left in place so a later call
 * (typically from the `ResizeObserver`-driven `map.resize()` in MapView,
 * or the next track sync) gets another chance.
 *
 * Exported so MapView can call this after every `map.resize()`: MapLibre
 * does not re-fit on its own when the container is resized, and a track
 * imported while the map was too small to fit (see above) would otherwise
 * stay stranded at the default view forever, even after the container
 * becomes usable.
 */
export function tryPendingFit(map: MapLibreMap, tracks: Track[]): void {
  const trackId = pendingFit.get(map)
  if (!trackId) return
  if (!canvasUsable(map)) return
  const track = tracks.find((t) => t.id === trackId)
  if (!track) {
    pendingFit.delete(map) // removed before it ever got fit
    return
  }
  const bounds = boundsFromCoords(renderCopy(track).coords)
  if (!bounds) {
    pendingFit.delete(map)
    return
  }
  fitCamera(map, bounds)
  pendingFit.delete(map)
}

/**
 * Moves the camera onto `trackId`, if it's still present in `tracks`.
 * No-op if the track has been removed (e.g. a stale locate request racing a
 * delete).
 *
 * Backs the per-row "定位" (locate) control in TrackList: auto-fit
 * (`pendingFit`/`tryPendingFit` above) only ever fires once, for the most
 * recently *added* track, so it's not a way back to a track the user has
 * since panned away from. This is that direct remedy. Deliberately routed
 * through `fitCamera` rather than calling `map.fitBounds` here directly, so
 * the small-container fallback that motivated this whole file applies to
 * manual locates too, not just the initial import fit.
 */
export function locateTrack(map: MapLibreMap, tracks: Track[], trackId: string): void {
  const track = tracks.find((t) => t.id === trackId)
  if (!track) return
  const bounds = boundsFromCoords(renderCopy(track).coords)
  if (!bounds) return
  fitCamera(map, bounds)
}

/**
 * One GeoJSON source + line layer per track (id `trk-${track.id}`).
 * - Existing sources are updated in place via `setData` (cheap, no
 *   layer flicker); colour/width/opacity are refreshed via
 *   `setPaintProperty` every call so per-track style edits and active-track
 *   changes apply immediately.
 * - Missing sources/layers are added.
 * - Sources/layers for tracks no longer in `tracks` are removed so the map
 *   doesn't accumulate stale layers as tracks get deleted.
 * - The most recently added track (i.e. present now but not in the
 *   previously-known set) is queued for a camera fit via `pendingFit` /
 *   `tryPendingFit` -- see those for why this is deferred rather than
 *   fitting inline.
 * - `activeTrackId`, when given, is rendered heavier and at full opacity;
 *   every other track is dimmed, so which track the toolbox/profile are
 *   currently acting on stays visually obvious once more than one is loaded.
 *
 * Caller must guard against calling this before the style has parsed (the
 * `'style.load'` event - NOT `map.isStyleLoaded()` or the `'load'` event,
 * both of which also wait for every source's tiles to finish loading, the
 * OSM raster basemap included) — adding a source before the style is parsed
 * throws in MapLibre.
 *
 * `opts.skipFit` (milestone N6 commit 2): `map.setStyle(...)` — how
 * MapView.tsx now switches basemap style — diffs the *entire* live style
 * (which includes every `trk-*` source/layer added imperatively here, since
 * `addSource`/`addLayer` mutate the same style object graph MapLibre diffs
 * against) against the new style spec, and removes anything the new spec
 * doesn't mention — every track layer, not just the old basemap. `'style.load'`
 * fires again once that diff settles, and this function runs again in
 * response (see MapView.tsx's `handleStyleLoad`) to re-add them, which is
 * exactly right. But without `skipFit`, every track would look "removed then
 * newly re-added" to this function's own `existing === undefined` check, and
 * the very last one synced would get queued into `pendingFit` — silently
 * re-centering the camera on a basemap switch, `syncTrackLayers`'s own
 * `pendingFit` bookkeeping never having been designed to distinguish "a
 * genuinely new track" from "a track re-added after its source/layer were
 * wiped out from under it". `skipFit: true` (passed only from that
 * style-swap re-sync path, never the initial mount) suppresses both queuing
 * *and* clears any stale pending marker, so a later unrelated resize can't
 * replay the same unwanted re-fit.
 */
export function syncTrackLayers(
  map: MapLibreMap,
  tracks: Track[],
  activeTrackId?: string,
  opts?: { skipFit?: boolean },
): void {
  const seen = knownTrackIds.get(map) ?? new Set<string>()
  const currentIds = new Set(tracks.map((t) => t.id))

  for (const id of seen) {
    if (currentIds.has(id)) continue
    const layerId = layerIdFor(id)
    if (map.getLayer(layerId)) map.removeLayer(layerId)
    if (map.getSource(layerId)) map.removeSource(layerId)
    seen.delete(id)
  }

  let newestTrack: Track | undefined
  tracks.forEach((t, i) => {
    const layerId = layerIdFor(t.id)
    const feature = trackToFeature(t)
    const color = t.meta.color ?? TRACK_PALETTE[i % TRACK_PALETTE.length]
    const baseWidth = t.meta.lineWidth ?? DEFAULT_LINE_WIDTH
    const isActive = t.id === activeTrackId
    // Only dim non-active tracks once something IS active -- with no
    // selection at all, every track should read at full strength.
    const opacity = activeTrackId === undefined || isActive ? 1 : 0.45
    const lineWidth = isActive ? baseWidth + 1.5 : baseWidth

    const existing = map.getSource(layerId) as GeoJSONSource | undefined
    if (existing) {
      existing.setData(feature)
      map.setPaintProperty(layerId, 'line-color', color)
      map.setPaintProperty(layerId, 'line-width', lineWidth)
      map.setPaintProperty(layerId, 'line-opacity', opacity)
    } else {
      map.addSource(layerId, { type: 'geojson', data: feature })
      map.addLayer({
        id: layerId,
        type: 'line',
        source: layerId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': color,
          'line-width': lineWidth,
          'line-opacity': opacity,
        },
      })
      seen.add(t.id)
      newestTrack = t
    }
  })
  knownTrackIds.set(map, seen)

  if (opts?.skipFit) {
    // Not a genuine "track added" event -- see this function's own doc
    // comment on `opts.skipFit`. Explicitly drop any pending marker rather
    // than leaving it for a later unrelated resize to consume.
    pendingFit.delete(map)
  } else {
    if (newestTrack) pendingFit.set(map, newestTrack.id)
    tryPendingFit(map, tracks)
  }
}

const EARTH_CIRCUMFERENCE_M = 40075016.686

/**
 * Screen-pixel tolerance -> ground-distance tolerance at the map's current
 * zoom/latitude, so a hover "grab radius" feels like a constant number of
 * pixels on screen instead of a constant number of metres on the ground.
 *
 * At zoom `z`, a Web Mercator tile is 256px wide and the whole equator
 * (`EARTH_CIRCUMFERENCE_M`) is covered by `256 * 2^z` px, so metres-per-pixel
 * at the equator is `EARTH_CIRCUMFERENCE_M / (256 * 2^z)`. Web Mercator also
 * compresses east-west ground distance by `cos(lat)` away from the equator,
 * so at latitude `lat` metres-per-pixel is that value times `cos(lat)`.
 * Multiplying by the desired pixel tolerance gives the metre tolerance.
 *
 * A hardcoded metre threshold (e.g. 200m) would be wrong at both ends: at
 * low zoom 200m is sub-pixel (impossible to hit), and at high zoom it's a
 * huge multi-hundred-pixel grab radius.
 */
export function pixelsToMeters(zoom: number, lat: number, pixels: number): number {
  const metersPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom)
  return metersPerPixel * pixels
}

/** Default on-screen grab radius for hover/nearest-point lookup, in pixels. */
export const HOVER_GRAB_PX = 15

function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371008.8
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Nearest render-copy vertex to (lng, lat) across all tracks, mapped back to
 * its full-precision point index. Returns undefined if nothing is within
 * `maxDistanceM`. Linear scan over render copies (<= RENDER_MAX points per
 * track) is acceptable at this scale; callers should pass a distance derived
 * from `pixelsToMeters` so the grab radius feels constant on screen.
 */
export function findNearestOnTrack(
  tracks: Track[],
  lng: number,
  lat: number,
  maxDistanceM: number,
): HoverState | undefined {
  let bestTrackId: string | undefined
  let bestIndex = -1
  let bestDist = Infinity

  for (const t of tracks) {
    const { idx, coords } = renderCopy(t)
    for (let i = 0; i < coords.length; i++) {
      const [lon, ptLat] = coords[i]
      const d = haversine(lng, lat, lon, ptLat)
      if (d < bestDist) {
        bestDist = d
        bestTrackId = t.id
        bestIndex = idx[i]
      }
    }
  }

  if (bestTrackId === undefined || bestDist > maxDistanceM) return undefined
  return { trackId: bestTrackId, index: bestIndex }
}

// One marker instance per map, so repeated hover updates don't leak markers.
const hoverMarkers = new WeakMap<MapLibreMap, Marker>()

/** Places/moves a single marker at the hovered point; removes it when `hover` is undefined. */
export function syncHoverMarker(map: MapLibreMap, tracks: Track[], hover?: HoverState): void {
  if (!hover) {
    const existing = hoverMarkers.get(map)
    if (existing) {
      existing.remove()
      hoverMarkers.delete(map)
    }
    return
  }

  const track = tracks.find((t) => t.id === hover.trackId)
  if (!track) return
  const lon = track.points.lon[hover.index]
  const lat = track.points.lat[hover.index]
  if (lon === undefined || lat === undefined) return

  let marker = hoverMarkers.get(map)
  if (!marker) {
    // setLngLat() before addTo(): Marker.addTo() unconditionally calls its
    // internal _update() at the end (to position the freshly-mounted DOM
    // element), and _update() dereferences _lngLat unconditionally too - if
    // it hasn't been set yet, addTo() throws
    // ("Cannot read properties of undefined (reading 'lng')") instead of
    // placing the marker. _update() itself already no-ops until _map is
    // set, so calling setLngLat() first (before the marker is attached to
    // any map) is safe.
    marker = new Marker({ color: '#1d4ed8' }).setLngLat([lon, lat]).addTo(map)
    hoverMarkers.set(map, marker)
  } else {
    marker.setLngLat([lon, lat])
  }
}

// Re-exported for existing call sites (this file's own getCpElement below,
// and cpEntities.ts's import of it) -- the canonical definition now lives in
// core/model/checkpoint.ts (see its own doc comment on CP_KIND_COLORS for
// why it moved out of this maplibre-gl-importing module).
export { CP_KIND_COLORS }

// One Marker per CP id, per map instance, so we can move/recolor markers in
// place instead of tearing down and recreating the whole set on every sync
// (which would flicker and defeat any CSS transitions).
const cpMarkers = new WeakMap<MapLibreMap, Map<string, Marker>>()

function styleCpMarkerElement(el: HTMLElement, cp: CheckPoint, ordinal: number): void {
  el.textContent = String(ordinal)
  el.style.width = '22px'
  el.style.height = '22px'
  el.style.borderRadius = '50%'
  el.style.display = 'flex'
  el.style.alignItems = 'center'
  el.style.justifyContent = 'center'
  el.style.fontSize = '11px'
  el.style.fontWeight = '600'
  el.style.color = '#fff'
  el.style.background = CP_KIND_COLORS[cp.kind]
  el.style.border = '2px solid #fff'
  el.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.4)'
  el.style.cursor = 'default'
}

/**
 * Places/moves one marker per CP, coloured by kind and labelled with its
 * ordinal (1-based list position, matching CpPanel/SegmentTable's numbering).
 * Removes markers for CPs no longer present in `cps`.
 *
 * `cps` is expected to already be scoped to `activeTrack` by the caller
 * (MapView filters `s.cps` down to `trackId === activeTrack.id` before
 * calling this) -- this function itself doesn't check CheckPoint.trackId, it
 * just resolves each CP's on-map position against `activeTrack` via
 * `anchorIndex`. If there is no active track (or the index is out of range,
 * e.g. right after switching tracks), the CP's original `clickLngLat` is
 * used as a fallback so the marker doesn't just disappear.
 */
export function syncCpMarkers(map: MapLibreMap, activeTrack: Track | undefined, cps: CheckPoint[]): void {
  let markers = cpMarkers.get(map)
  if (!markers) {
    markers = new Map()
    cpMarkers.set(map, markers)
  }

  const currentIds = new Set(cps.map((c) => c.id))
  for (const [id, marker] of markers) {
    if (currentIds.has(id)) continue
    marker.remove()
    markers.delete(id)
  }

  cps.forEach((cp, i) => {
    let lon: number | undefined
    let lat: number | undefined
    if (activeTrack && cp.anchorIndex >= 0 && cp.anchorIndex < activeTrack.points.lon.length) {
      lon = activeTrack.points.lon[cp.anchorIndex]
      lat = activeTrack.points.lat[cp.anchorIndex]
    } else if (cp.clickLngLat) {
      ;[lon, lat] = cp.clickLngLat
    }
    if (lon === undefined || lat === undefined) return

    const ordinal = i + 1
    let marker = markers!.get(cp.id)
    if (!marker) {
      const el = document.createElement('div')
      styleCpMarkerElement(el, cp, ordinal)
      // Same ordering rule as syncHoverMarker above: setLngLat() before
      // addTo(), never the reverse - addTo() throws in maplibre-gl v6 if the
      // marker has no lngLat set yet.
      marker = new Marker({ element: el }).setLngLat([lon, lat]).addTo(map)
      markers!.set(cp.id, marker)
    } else {
      marker.setLngLat([lon, lat])
      styleCpMarkerElement(marker.getElement(), cp, ordinal)
    }
  })
}
