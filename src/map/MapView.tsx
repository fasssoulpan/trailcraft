import { useEffect, useRef, useState } from 'react'
import {
  Map as MapLibreMap,
  NavigationControl,
  type ErrorEvent as MapLibreErrorEvent,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAppStore, type HoverState } from '../state/appStore'
import { CP_KIND_LABELS, type CpKind } from '../core/model/checkpoint'
import {
  findNearestOnTrack,
  pixelsToMeters,
  syncCpMarkers,
  syncHoverMarker,
  syncTrackLayers,
  HOVER_GRAB_PX,
} from './trackLayer'

/** Screen-space anchor + world coordinate for the pending "add CP" inline form. */
interface CpFormState {
  lngLat: [number, number]
  point: { x: number; y: number }
}

/**
 * Raster OSM basemap style. Exported as a constant so the tile URL is easy
 * to swap out: OpenStreetMap's own tile CDN (tile.openstreetmap.org) is
 * slow/unreliable to reach from mainland China, which is TrailCraft's
 * target market, so this is expected to become a user- or env-configurable
 * URL (e.g. pointing at a China-reachable mirror or self-hosted tiles) in a
 * later task rather than staying hardcoded.
 */
const OSM_SOURCE_ID = 'osm'

export const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    [OSM_SOURCE_ID]: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: OSM_SOURCE_ID, type: 'raster', source: OSM_SOURCE_ID }],
}

// Roughly the center of China, used only as the pre-track-load default view.
const DEFAULT_CENTER: [number, number] = [104.0, 35.0]
const DEFAULT_ZOOM = 3

// MapLibre's public `ErrorEvent` type only declares `error`, but events
// bubbled up from a source (e.g. a failed tile request) are extended with
// `sourceId` before reaching the map's `error` listeners at runtime — see
// `Style.addSource`'s `setEventedParent` in maplibre-gl. Narrow locally
// rather than widening the imported type.
type MapSourceErrorEvent = MapLibreErrorEvent & { sourceId?: string }

export function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const loadedRef = useRef(false)
  // Basemap tile/source failures are common (OSM's CDN is unreliable from
  // mainland China) and should surface once as a small diagnostic notice,
  // not spam one per failed tile.
  const [tileErrorShown, setTileErrorShown] = useState(false)

  const tracks = useAppStore((s) => s.tracks)
  const hover = useAppStore((s) => s.hover)
  const setHover = useAppStore((s) => s.setHover)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const allCps = useAppStore((s) => s.cps)
  const addCp = useAppStore((s) => s.addCp)

  const activeTrack = tracks.find((t) => t.id === activeTrackId)
  // CheckPoint.trackId is the source of truth for which track a CP belongs
  // to; s.cps spans every track, so markers/ordinals must be scoped to the
  // active track's own subset -- otherwise switching tracks would draw CP
  // markers resolved against the wrong track's geometry (syncCpMarkers falls
  // back to clickLngLat for out-of-range indices, which silently hides this
  // exact bug instead of crashing).
  const cps = activeTrackId ? allCps.filter((c) => c.trackId === activeTrackId) : []

  // Inline "add CP" form, opened by clicking near the active track.
  const [cpForm, setCpForm] = useState<CpFormState | undefined>()
  const [cpKind, setCpKind] = useState<CpKind>('cp')
  const [cpName, setCpName] = useState('')

  // Refs mirroring the latest props/state so long-lived callbacks (the
  // MapLibre 'style.load' handler registered once in the mount effect, the
  // rAF-throttled mousemove handler) always see current data without
  // needing to be re-registered on every tracks/hover change.
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  const setHoverRef = useRef(setHover)
  setHoverRef.current = setHover
  const activeTrackRef = useRef(activeTrack)
  activeTrackRef.current = activeTrack
  const cpsRef = useRef(cps)
  cpsRef.current = cps
  const setCpFormRef = useRef(setCpForm)
  setCpFormRef.current = setCpForm

  // Default the inline form's name to the next ordinal each time it's
  // (re)opened - but only then, not on every cps change, so it doesn't
  // clobber whatever the user is mid-typing while the form stays open.
  useEffect(() => {
    if (cpForm) setCpName(`CP${cps.length + 1}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpForm])

  // Create the map once; destroy on unmount.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const map = new MapLibreMap({
      container,
      style: OSM_STYLE,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    })
    map.addControl(new NavigationControl(), 'top-right')
    mapRef.current = map

    // Gate on the 'style.load' event, NOT 'load'. They sound
    // interchangeable but aren't:
    //  - 'style.load' fires as soon as the style JSON has been parsed and
    //    its sources registered (Style._load sets Style._loaded and fires
    //    it synchronously, before any tile fetch begins). This is the
    //    condition addSource/addLayer actually check internally
    //    (Style._checkLoaded), so it's safe to sync our own layers here.
    //  - 'load' only fires once map.loaded() is true, which recursively
    //    requires style.loaded(), which requires EVERY registered source's
    //    tiles to have finished loading (see Style.loaded() iterating
    //    tileManagers) - i.e. the OSM raster basemap included. That's the
    //    exact same "hangs forever if the basemap CDN is unreachable"
    //    problem this fix is meant to solve, just moved from
    //    isStyleLoaded() to 'load'. Verified by reading the maplibre-gl
    //    source directly (Map._render / Style._load / Style.loaded /
    //    TileManager.loaded).
    const handleStyleLoad = () => {
      loadedRef.current = true
      syncTrackLayers(map, tracksRef.current)
      syncHoverMarker(map, tracksRef.current, hoverRef.current)
      syncCpMarkers(map, activeTrackRef.current, cpsRef.current)
    }
    map.on('style.load', handleStyleLoad)

    // Tile/source errors (e.g. the OSM basemap CDN being unreachable) must
    // not be silent: the app's own layers render independently of the
    // basemap (see the `loadedRef` gate below), so without this the user
    // just sees a blank grey map with no indication of what's wrong. Only
    // the OSM source is watched here — the tracks/hover-marker sources are
    // local GeoJSON and don't fail this way — and it fires at most once per
    // map instance so a run of failed tiles doesn't spam the notice.
    let tileErrorNoticeShown = false
    const handleError = (e: MapSourceErrorEvent) => {
      if (tileErrorNoticeShown) return
      if (e.sourceId !== OSM_SOURCE_ID) return
      tileErrorNoticeShown = true
      setTileErrorShown(true)
    }
    map.on('error', handleError)

    // A raw mousemove handler doing a linear scan over every track's render
    // copy on every event would thrash (mousemove fires far faster than the
    // display refreshes). Throttle to one lookup per animation frame instead.
    let rafId: number | null = null
    let pendingEvent: MapMouseEvent | null = null

    const runPendingLookup = () => {
      rafId = null
      const e = pendingEvent
      pendingEvent = null
      if (!e) return
      const zoom = map.getZoom()
      const maxDistanceM = pixelsToMeters(zoom, e.lngLat.lat, HOVER_GRAB_PX)
      const nearest: HoverState | undefined = findNearestOnTrack(
        tracksRef.current,
        e.lngLat.lng,
        e.lngLat.lat,
        maxDistanceM,
      )
      setHoverRef.current(nearest)
    }

    const handleMouseMove = (e: MapMouseEvent) => {
      pendingEvent = e
      if (rafId != null) return
      rafId = requestAnimationFrame(runPendingLookup)
    }
    const handleMouseOut = () => {
      pendingEvent = null
      if (rafId != null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      setHoverRef.current(undefined)
    }
    map.on('mousemove', handleMouseMove)
    map.on('mouseout', handleMouseOut)

    // Clicking near the active track opens the inline "add CP" form;
    // clicking anywhere else (no active track, or too far from it) does
    // nothing. Reuses the exact same pixel-based proximity logic as hover
    // (findNearestOnTrack + pixelsToMeters) so the "near enough to click"
    // radius feels consistent with the "near enough to hover" one - but
    // scoped to just the active track's render copy, since a click near some
    // *other* track shouldn't open a CP form for the active one.
    const handleClick = (e: MapMouseEvent) => {
      const active = activeTrackRef.current
      if (!active) {
        setCpFormRef.current(undefined)
        return
      }
      const zoom = map.getZoom()
      const maxDistanceM = pixelsToMeters(zoom, e.lngLat.lat, HOVER_GRAB_PX)
      const nearest = findNearestOnTrack([active], e.lngLat.lng, e.lngLat.lat, maxDistanceM)
      if (!nearest) {
        setCpFormRef.current(undefined)
        return
      }
      setCpFormRef.current({
        lngLat: [e.lngLat.lng, e.lngLat.lat],
        point: { x: e.point.x, y: e.point.y },
      })
    }
    map.on('click', handleClick)

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      map.off('style.load', handleStyleLoad)
      map.off('error', handleError)
      map.off('mousemove', handleMouseMove)
      map.off('mouseout', handleMouseOut)
      map.off('click', handleClick)
      map.remove()
      mapRef.current = null
      loadedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-sync track layers whenever the track list changes.
  //
  // Gate on `loadedRef` (set once the 'style.load' event has fired, i.e. the
  // style is parsed and sources/layers can be added - see the comment by
  // `handleStyleLoad` above) rather than `map.isStyleLoaded()` or the 'load'
  // event. Both of those also require every source in the style - including
  // the OSM raster basemap - to have finished loading its tiles, which never
  // happens when the basemap CDN is slow/unreachable (routine from mainland
  // China, this product's primary market). Gating on either would silently
  // stop all of the app's own rendering, which doesn't depend on the
  // basemap, indefinitely.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!loadedRef.current) return // the 'style.load' handler above will pick up tracksRef.current once it fires
    syncTrackLayers(map, tracks)
  }, [tracks])

  // Re-sync the hover marker whenever hover state changes. Same gate as the
  // track-sync effect above, and for the same reason.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!loadedRef.current) return
    syncHoverMarker(map, tracks, hover)
  }, [tracks, hover])

  // Re-sync CP markers whenever the CP list, the active track, or the
  // track's own data changes (e.g. a toolbox op replacing the active track
  // with a re-simplified copy shifts every anchorIndex's coordinates). Same
  // gate as the effects above.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!loadedRef.current) return
    syncCpMarkers(map, activeTrack, cps)
  }, [activeTrack, cps])

  function confirmCp() {
    if (!cpForm) return
    addCp(cpKind, cpName.trim() || `CP${cps.length + 1}`, cpForm.lngLat)
    setCpForm(undefined)
    setCpKind('cp')
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {tileErrorShown && (
        <div
          role="status"
          style={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            zIndex: 1,
            maxWidth: '80%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            fontSize: 12,
            lineHeight: 1.4,
            color: '#7c2d12',
            background: 'rgba(255, 251, 235, 0.95)',
            border: '1px solid #fbbf24',
            borderRadius: 6,
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
          }}
        >
          <span>底图瓦片加载失败，轨迹功能不受影响</span>
          <button
            type="button"
            onClick={() => setTileErrorShown(false)}
            aria-label="关闭提示"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              color: 'inherit',
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}
      {cpForm && (
        <div
          className="map-cp-form"
          style={{ position: 'absolute', left: cpForm.point.x + 12, top: cpForm.point.y - 12, zIndex: 2 }}
        >
          <label className="map-cp-form__field">
            类型
            <select value={cpKind} onChange={(e) => setCpKind(e.target.value as CpKind)}>
              {(Object.keys(CP_KIND_LABELS) as CpKind[]).map((k) => (
                <option key={k} value={k}>
                  {CP_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="map-cp-form__field">
            名称
            <input type="text" value={cpName} onChange={(e) => setCpName(e.target.value)} />
          </label>
          <div className="map-cp-form__actions">
            <button type="button" onClick={confirmCp}>
              添加
            </button>
            <button type="button" onClick={() => setCpForm(undefined)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
