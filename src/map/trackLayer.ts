import { GeoJSONSource, LngLatBounds, Marker, type Map as MapLibreMap } from 'maplibre-gl'
import type { Feature, LineString } from 'geojson'
import type { Track } from '../core/model/track'
import type { CheckPoint, CpKind } from '../core/model/checkpoint'
import type { HoverState } from '../state/appStore'
import { decimateIndices } from '../core/toolbox/decimate'

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

// Cycled per-track so multiple overlapping tracks stay visually distinguishable.
const TRACK_COLORS = ['#e63946', '#1d4ed8', '#2a9d8f', '#f4a261', '#9333ea', '#0891b2']

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

/**
 * One GeoJSON source + line layer per track (id `trk-${track.id}`).
 * - Existing sources are updated in place via `setData` (cheap, no
 *   layer flicker).
 * - Missing sources/layers are added.
 * - Sources/layers for tracks no longer in `tracks` are removed so the map
 *   doesn't accumulate stale layers as tracks get deleted.
 * - The most recently added track (i.e. present now but not in the
 *   previously-known set) gets `fitBounds`.
 *
 * Caller must guard against calling this before the style has parsed (the
 * `'style.load'` event - NOT `map.isStyleLoaded()` or the `'load'` event,
 * both of which also wait for every source's tiles to finish loading, the
 * OSM raster basemap included) — adding a source before the style is parsed
 * throws in MapLibre.
 */
export function syncTrackLayers(map: MapLibreMap, tracks: Track[]): void {
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
    const existing = map.getSource(layerId) as GeoJSONSource | undefined
    if (existing) {
      existing.setData(feature)
    } else {
      map.addSource(layerId, { type: 'geojson', data: feature })
      map.addLayer({
        id: layerId,
        type: 'line',
        source: layerId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': TRACK_COLORS[i % TRACK_COLORS.length],
          'line-width': 3,
        },
      })
      seen.add(t.id)
      newestTrack = t
    }
  })
  knownTrackIds.set(map, seen)

  if (newestTrack) {
    const coords = renderCopy(newestTrack).coords
    if (coords.length > 0) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new LngLatBounds(coords[0], coords[0]),
      )
      map.fitBounds(bounds, { padding: 40, duration: 300 })
    }
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

// Distinct per-kind marker colour so CPs stay visually distinguishable at a
// glance (danger/quit points in particular should read as "different" from
// a plain CP even before you read the label).
const CP_KIND_COLORS: Record<CpKind, string> = {
  cp: '#1d4ed8',
  aid: '#16a34a',
  gear: '#ca8a04',
  danger: '#dc2626',
  quit: '#6b7280',
}

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
