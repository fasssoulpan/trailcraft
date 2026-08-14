import { useEffect, useRef, useState } from 'react'
import {
  Map as MapLibreMap,
  NavigationControl,
  type ErrorEvent as MapLibreErrorEvent,
  type MapMouseEvent,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAppStore, type HoverState } from '../state/appStore'
import { CP_KIND_LABELS, type CpKind } from '../core/model/checkpoint'
import { ALL_RASTER_SOURCE_IDS, OSM_STYLE, styleSpecForBasemap } from './basemapStyle'
import { hoverReadoutLabel } from '../ui/hudStats'
import type { Vertex } from '../core/toolbox/draw'
import {
  clearDrawLayer,
  findNearestOnTrack,
  locateTrack,
  nearestDrawVertexIndex,
  pixelsToMeters,
  syncCpMarkers,
  syncDrawLayer,
  syncHoverMarker,
  syncHoverReadout,
  syncTrackLayers,
  tryPendingFit,
  HOVER_GRAB_PX,
} from './trackLayer'

// How long to hold a 'click' before actually committing it as a new drawn
// vertex, so a 'dblclick' arriving shortly after (browsers/MapLibre both
// fire click, click, dblclick for a double-click) can cancel it instead of
// leaving two stray extra vertices right at the finish point.
const DRAW_CLICK_COMMIT_DELAY_MS = 220

// On-screen movement (px) between a vertex-drag's mousedown and mouseup
// below which it's still treated as a plain click (e.g. "grabbed" a vertex
// but didn't actually move it) -- matches the small-jitter tolerance most
// pointer-based UIs use to distinguish an intentional drag from a
// stationary press.
const DRAG_THRESHOLD_PX = 3

// Re-exported so anything that previously imported `OSM_STYLE` from this
// module (its original home, before milestone N6 commit 2 moved the actual
// definition into basemapStyle.ts alongside the new Esri satellite style --
// see that file's own doc comment for why) keeps resolving.
export { OSM_STYLE }

/** Screen-space anchor + world coordinate for the pending "add CP" inline form. */
interface CpFormState {
  lngLat: [number, number]
  point: { x: number; y: number }
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
  const locateRequest = useAppStore((s) => s.locateRequest)
  const clearLocateRequest = useAppStore((s) => s.clearLocateRequest)
  const planBasemapStyle = useAppStore((s) => s.planBasemapStyle)
  const statsOptions = useAppStore((s) => s.statsOptions)
  const drawMode = useAppStore((s) => s.drawMode)
  const drawVertices = useAppStore((s) => s.drawVertices)
  const drawCursor = useAppStore((s) => s.drawCursor)
  const addDrawVertex = useAppStore((s) => s.addDrawVertex)
  const moveDrawVertex = useAppStore((s) => s.moveDrawVertex)
  const deleteDrawVertex = useAppStore((s) => s.deleteDrawVertex)
  const setDrawCursor = useAppStore((s) => s.setDrawCursor)
  const finishDraw = useAppStore((s) => s.finishDraw)

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
  const statsOptionsRef = useRef(statsOptions)
  statsOptionsRef.current = statsOptions
  const activeTrackRef = useRef(activeTrack)
  activeTrackRef.current = activeTrack
  const cpsRef = useRef(cps)
  cpsRef.current = cps
  const setCpFormRef = useRef(setCpForm)
  setCpFormRef.current = setCpForm
  const drawModeRef = useRef(drawMode)
  drawModeRef.current = drawMode
  const drawVerticesRef = useRef(drawVertices)
  drawVerticesRef.current = drawVertices
  const drawCursorRef = useRef(drawCursor)
  drawCursorRef.current = drawCursor
  const addDrawVertexRef = useRef(addDrawVertex)
  addDrawVertexRef.current = addDrawVertex
  const moveDrawVertexRef = useRef(moveDrawVertex)
  moveDrawVertexRef.current = moveDrawVertex
  const deleteDrawVertexRef = useRef(deleteDrawVertex)
  deleteDrawVertexRef.current = deleteDrawVertex
  const setDrawCursorRef = useRef(setDrawCursor)
  setDrawCursorRef.current = setDrawCursor
  const finishDrawRef = useRef(finishDraw)
  finishDrawRef.current = finishDraw

  // Default the inline form's name to the next ordinal each time it's
  // (re)opened - but only then, not on every cps change, so it doesn't
  // clobber whatever the user is mid-typing while the form stays open.
  useEffect(() => {
    if (cpForm) setCpName(`CP${cps.length + 1}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpForm])

  // Draw mode and the inline "add CP" form are mutually exclusive click
  // targets on the same map (see the mount effect's `handleClick`, which
  // never opens a CP form while `drawModeRef.current` is true) -- but if a
  // CP form was already open the moment the user toggled draw mode on, it
  // would otherwise just sit there, stale, floating over the draw
  // interaction. Close it the instant draw mode turns on.
  useEffect(() => {
    if (drawMode) setCpForm(undefined)
  }, [drawMode])

  // Create the map once; destroy on unmount.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const map = new MapLibreMap({
      container,
      // The store's persisted value is already correct at this point --
      // loadBasemapStyle('plan') runs synchronously at store creation (see
      // appStore.ts), so the very first render already has the right style,
      // with no async load/race to worry about here.
      style: styleSpecForBasemap(planBasemapStyle),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    })
    map.addControl(new NavigationControl(), 'top-right')
    mapRef.current = map
    // Dev-only debugging handle. The map instance is otherwise reachable only
    // by walking React's fiber tree, which is fragile and makes diagnosing
    // "my track isn't drawing" needlessly hard. Stripped from production
    // builds by the `import.meta.env.DEV` guard.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __trailcraftMap?: unknown; __trailcraftMapErrors?: string[] }
      w.__trailcraftMap = map
      w.__trailcraftMapErrors = []
      // MapLibre reports source/worker/tile failures through its own 'error'
      // event rather than by throwing, so they are invisible to a plain
      // try/catch and easy to miss in a busy console. Collect them for the
      // dev badge (see src/ui/MapDebugBadge.tsx).
      map.on('error', (e: { error?: { message?: string }; sourceId?: string }) => {
        const msg = `${e.sourceId ? `[${e.sourceId}] ` : ''}${e.error?.message ?? 'unknown'}`
        w.__trailcraftMapErrors?.push(msg)
      })
    }

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
    // This same listener also fires again on every later `map.setStyle(...)`
    // call (milestone N6 commit 2's basemap-style switch, see the
    // `planBasemapStyle` effect below) -- MapLibre's default diff-based
    // `setStyle` path (`Style#setState`) fires the identical 'style.load'
    // event once its diff has been applied, and that diff removes every
    // `trk-*` source/layer this function itself added (they're part of the
    // same live style graph being diffed, even though nothing in *this*
    // component added them to the new style spec) -- so re-running the sync
    // functions here is what makes tracks/CP markers/hover marker survive a
    // basemap switch, not just the very first load. `isInitial` distinguishes
    // the two cases so `syncTrackLayers` doesn't treat "every track just got
    // wiped out and re-added by the style diff" as "every track is newly
    // added" and re-fit the camera on a basemap switch (see that function's
    // own doc comment on `opts.skipFit`).
    const handleStyleLoad = () => {
      const isInitial = !loadedRef.current
      loadedRef.current = true
      syncTrackLayers(map, tracksRef.current, activeTrackRef.current?.id, { skipFit: !isInitial })
      syncHoverMarker(map, tracksRef.current, hoverRef.current)
      syncHoverReadout(
        map,
        tracksRef.current,
        hoverRef.current,
        hoverReadoutLabel(tracksRef.current, hoverRef.current, statsOptionsRef.current),
      )
      syncCpMarkers(map, activeTrackRef.current, cpsRef.current)
      if (drawModeRef.current) syncDrawLayer(map, drawVerticesRef.current, drawCursorRef.current)
    }
    map.on('style.load', handleStyleLoad)

    // MapLibre never notices its own container being resized -- it keeps
    // rendering at whatever backing-canvas size it had at creation/last
    // `resize()` call, so a container that grows or shrinks (the sidebar
    // and profile splitters added alongside this, or just the segment-table
    // panel expanding) leaves the map either letterboxed or clipped until
    // something explicitly tells it to remeasure. `map.resize()` is that
    // "something"; it's cheap to call on every observed size change.
    //
    // This is also what makes a track that arrived while the container was
    // too small to fit (e.g. the 60x0px window mid-layout that motivated
    // `tryPendingFit` in trackLayer.ts) eventually get its camera fit: once
    // the container becomes usable, resize() fires, and this handler gives
    // the pending fit its next chance to run.
    const ro = new ResizeObserver(() => {
      const m = mapRef.current
      if (!m) return
      m.resize()
      tryPendingFit(m, tracksRef.current)
    })
    ro.observe(container)

    // Tile/source errors (e.g. the OSM basemap CDN being unreachable) must
    // not be silent: the app's own layers render independently of the
    // basemap (see the `loadedRef` gate below), so without this the user
    // just sees a blank grey map with no indication of what's wrong. Only
    // the raster basemap sources are watched here (ALL_RASTER_SOURCE_IDS,
    // now two of them since milestone N6 commit 2 added the Esri satellite
    // style) — the tracks/hover-marker sources are local GeoJSON and don't
    // fail this way — and it fires at most once per map instance so a run of
    // failed tiles doesn't spam the notice.
    let tileErrorNoticeShown = false
    const handleError = (e: MapSourceErrorEvent) => {
      if (tileErrorNoticeShown) return
      if (!e.sourceId || !ALL_RASTER_SOURCE_IDS.includes(e.sourceId)) return
      tileErrorNoticeShown = true
      setTileErrorShown(true)
    }
    map.on('error', handleError)

    // A raw mousemove handler doing a linear scan over every track's render
    // copy on every event would thrash (mousemove fires far faster than the
    // display refreshes). Throttle to one lookup per animation frame instead.
    // The same throttle serves both interaction modes below (normal hover
    // lookup, and draw-mode's rubber-band cursor / vertex drag) -- they're
    // mutually exclusive (see `drawModeRef` branch inside), never both live
    // at once, so one rAF budget is enough.
    let rafId: number | null = null
    let pendingEvent: MapMouseEvent | null = null

    // Draw-mode-only interaction state. Deliberately plain closure
    // variables, not React state or store fields: they're transient
    // per-gesture bookkeeping (which vertex a mousedown grabbed, whether the
    // pointer has actually moved since) that nothing outside this effect
    // needs to read, exactly like `rafId`/`pendingEvent` above.
    let draggingIndex: number | null = null
    let dragStartPoint: { x: number; y: number } | null = null
    let dragMoved = false
    let clickTimeoutId: number | null = null

    const runPendingLookup = () => {
      rafId = null
      const e = pendingEvent
      pendingEvent = null
      if (!e) return

      if (drawModeRef.current) {
        if (draggingIndex !== null) {
          if (dragStartPoint) {
            const dx = e.point.x - dragStartPoint.x
            const dy = e.point.y - dragStartPoint.y
            if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) dragMoved = true
          }
          moveDrawVertexRef.current(draggingIndex, [e.lngLat.lng, e.lngLat.lat])
        } else {
          setDrawCursorRef.current([e.lngLat.lng, e.lngLat.lat])
        }
        return
      }

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
      if (drawModeRef.current) setDrawCursorRef.current(undefined)
      else setHoverRef.current(undefined)
    }
    map.on('mousemove', handleMouseMove)
    map.on('mouseout', handleMouseOut)

    // Draw mode grabs an existing vertex on mousedown (within the same
    // pixel grab radius hover/CP-click use) so the following mousemove
    // events drag it instead of panning the map -- `dragPan.disable()` for
    // the duration is what stops MapLibre's own pan handler from also
    // reacting to the same pointer movement.
    const handleMouseDown = (e: MapMouseEvent) => {
      if (!drawModeRef.current) return
      const zoom = map.getZoom()
      const maxDistanceM = pixelsToMeters(zoom, e.lngLat.lat, HOVER_GRAB_PX)
      const idx = nearestDrawVertexIndex(drawVerticesRef.current, e.lngLat.lng, e.lngLat.lat, maxDistanceM)
      if (idx === undefined) return
      draggingIndex = idx
      dragStartPoint = { x: e.point.x, y: e.point.y }
      dragMoved = false
      map.dragPan.disable()
    }
    const handleMouseUp = () => {
      if (draggingIndex === null) return
      draggingIndex = null
      dragStartPoint = null
      map.dragPan.enable()
    }
    map.on('mousedown', handleMouseDown)
    map.on('mouseup', handleMouseUp)

    // Right-click deletes the nearest vertex within grab range -- the "clear
    // way to delete one" this mode needs beyond ToolboxPanel's "删除最后一点"
    // button (which only ever removes the tail of the list).
    const handleContextMenu = (e: MapMouseEvent) => {
      if (!drawModeRef.current) return
      e.preventDefault() // suppress the browser's native context menu
      const zoom = map.getZoom()
      const maxDistanceM = pixelsToMeters(zoom, e.lngLat.lat, HOVER_GRAB_PX)
      const idx = nearestDrawVertexIndex(drawVerticesRef.current, e.lngLat.lng, e.lngLat.lat, maxDistanceM)
      if (idx !== undefined) deleteDrawVertexRef.current(idx)
    }
    map.on('contextmenu', handleContextMenu)

    // Clicking near the active track opens the inline "add CP" form;
    // clicking anywhere else (no active track, or too far from it) does
    // nothing. Reuses the exact same pixel-based proximity logic as hover
    // (findNearestOnTrack + pixelsToMeters) so the "near enough to click"
    // radius feels consistent with the "near enough to hover" one - but
    // scoped to just the active track's render copy, since a click near some
    // *other* track shouldn't open a CP form for the active one.
    //
    // Draw mode takes over this same 'click' event entirely (mutually
    // exclusive with the CP-form path below, never both): a plain click adds
    // a new vertex at the cursor, unless it's actually the tail end of a
    // vertex-grab/drag gesture (`draggingIndex`/`dragMoved` from the
    // mousedown/mousemove handlers above) — otherwise grabbing a vertex in
    // place, or dragging it, would *also* drop a duplicate new vertex right
    // where the pointer came up. The commit itself is delayed by
    // `DRAW_CLICK_COMMIT_DELAY_MS` so a genuine double-click (which finishes
    // the route instead, see `handleDblClick` below) can cancel it before it
    // lands -- otherwise the browser's own click,click,dblclick sequence
    // would leave two stray extra vertices right at the finish point.
    const handleClick = (e: MapMouseEvent) => {
      if (drawModeRef.current) {
        if (dragMoved) {
          dragMoved = false
          return
        }
        if (clickTimeoutId != null) return
        const lngLat: Vertex = [e.lngLat.lng, e.lngLat.lat]
        clickTimeoutId = window.setTimeout(() => {
          clickTimeoutId = null
          addDrawVertexRef.current(lngLat)
        }, DRAW_CLICK_COMMIT_DELAY_MS)
        return
      }

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

    // Double-click finishes the route instead of MapLibre's default
    // "zoom in" -- `preventDefault()` on the MapMouseEvent is MapLibre's own
    // documented way for a listener to suppress the built-in handler for the
    // same event (mirrors how `cesium/viewer.ts` removes the equivalent
    // Cesium input action, just via this library's own mechanism instead).
    const handleDblClick = (e: MapMouseEvent) => {
      if (!drawModeRef.current) return
      e.preventDefault()
      if (clickTimeoutId != null) {
        clearTimeout(clickTimeoutId)
        clickTimeoutId = null
      }
      finishDrawRef.current()
    }
    map.on('dblclick', handleDblClick)

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      if (clickTimeoutId != null) clearTimeout(clickTimeoutId)
      ro.disconnect()
      map.off('style.load', handleStyleLoad)
      map.off('error', handleError)
      map.off('mousemove', handleMouseMove)
      map.off('mouseout', handleMouseOut)
      map.off('mousedown', handleMouseDown)
      map.off('mouseup', handleMouseUp)
      map.off('contextmenu', handleContextMenu)
      map.off('click', handleClick)
      map.off('dblclick', handleDblClick)
      map.remove()
      mapRef.current = null
      loadedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Applies a later basemap-style change (LayerPanel, milestone N6 commit 2)
  // via `map.setStyle`. The initial style is already correct at construction
  // time (see the mount effect above), so this only needs to react to
  // *subsequent* changes -- gated on `loadedRef` for the same reason every
  // other post-mount sync effect in this file is (calling `setStyle` before
  // the initial style has parsed throws in MapLibre, same as `addSource`
  // would). `map.setStyle` re-fires 'style.load' synchronously in the same
  // call for an object style spec (verified by reading maplibre-gl's own
  // source: `Map#_diffStyle`'s object-spec branch has no `await` before
  // calling `_updateDiff`, which fires the event) -- so by the time this
  // effect returns, `handleStyleLoad` has already re-added every track/CP/
  // hover layer via `syncTrackLayers`/`syncCpMarkers`/`syncHoverMarker`.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!loadedRef.current) return
    map.setStyle(styleSpecForBasemap(planBasemapStyle))
  }, [planBasemapStyle])

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
    syncTrackLayers(map, tracks, activeTrackId)
  }, [tracks, activeTrackId])

  // Re-sync the hover marker (and its readout popup) whenever hover state
  // changes. Same gate as the track-sync effect above, and for the same
  // reason. `statsOptions` is in the dep array too -- a mid-session
  // recalibration (segment table's threshold slider) must update the
  // popup's ascent figure even though `hover` itself didn't change, exactly
  // like `ProfileCanvas.tsx`'s own hover readout does via its `stats` dep.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!loadedRef.current) return
    syncHoverMarker(map, tracks, hover)
    syncHoverReadout(map, tracks, hover, hoverReadoutLabel(tracks, hover, statsOptions))
  }, [tracks, hover, statsOptions])

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

  // Draws (or tears down) the in-progress hand-drawn route. Same gate as the
  // effects above. Explicitly tears down via `clearDrawLayer` the moment
  // `drawMode` goes false (toggled off, cancelled, or finished) rather than
  // just syncing an empty vertex list, so no stale source/layer lingers on
  // the map in between draws.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!loadedRef.current) return
    if (drawMode) syncDrawLayer(map, drawVertices, drawCursor)
    else clearDrawLayer(map)
  }, [drawMode, drawVertices, drawCursor])

  // Acts on the "定位" (locate) request from a TrackList row (see
  // appStore's `locateRequest`/`requestLocate`). Keyed on the request's
  // `seq`, not just its `trackId` -- a plain `[locateRequest?.trackId]` dep
  // would treat two consecutive locate clicks on the *same* track as "no
  // change" and skip the second camera move entirely, since the id alone
  // doesn't change between them. Always clears the request afterwards
  // (even if there was nothing usable to act on, e.g. the track was
  // deleted in the meantime) so a stale request can't be replayed by some
  // unrelated re-render.
  useEffect(() => {
    if (!locateRequest) return
    const map = mapRef.current
    if (map && loadedRef.current) {
      locateTrack(map, tracksRef.current, locateRequest.trackId)
    }
    clearLocateRequest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateRequest?.seq])

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
