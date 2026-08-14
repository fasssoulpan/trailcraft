import { useEffect, useRef, useState } from 'react'
import type { CesiumViewerHandle, ProviderReport } from '../cesium/viewer'
import type { FlythroughEngine, FlythroughProgressInfo } from '../cesium/flythrough'
import type { ContourHandle } from '../cesium/contours'
import type { ExportHandle } from '../cesium/frameExport'
import { EXPORT_RESOLUTIONS, type ExportProgressInfo, type ExportMode, type ExportResolutionKey } from '../cesium/exportResolutions'
import type { Track } from '../core/model/track'
import { useAppStore } from '../state/appStore'
import { FlyControls } from './FlyControls'
import { FlyOverlayLayer } from './FlyOverlayLayer'
import { HudOverlay, type HudOverlayHandle } from './HudOverlay'
import { CheckpointCard, type CheckpointCardHandle } from './CheckpointCard'
import { RadarOverlay, type RadarOverlayHandle } from './RadarOverlay'
import { getHudTrackStats } from './hudStats'
import { buildRadarTargets } from '../overlay/radarTargets'

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; providers: ProviderReport }
  | { status: 'error'; message: string }

const TERRAIN_LABEL: Record<ProviderReport['terrain'], string> = {
  maptiler: 'MapTiler',
  esri: 'Esri',
  // Explicit per the P1 brief: a silent downgrade to flat terrain must read
  // as "no free 3D terrain service was reachable just now", not as "the app
  // is broken" -- the mountains looking flat has an actual, nameable cause.
  ellipsoid: '平面(三维地形服务不可达)',
}

const IMAGERY_LABEL: Record<ProviderReport['imagery'], string> = {
  maptiler: 'MapTiler',
  esri: 'Esri',
}

/**
 * Distinguishes "the several-MB Cesium chunk itself never arrived" (slow/
 * blocked network, stale deploy hash after a redeploy) from "the chunk
 * loaded fine but something inside createViewer failed" (e.g. WebGL
 * unavailable) -- terrain/imagery network failures specifically do NOT
 * reach here, since terrainSelection.ts's fallback chain degrades all the
 * way to EllipsoidTerrainProvider (which cannot itself fail) rather than
 * ever rejecting; see the 'ready' state's provider badge for how *that*
 * degradation is surfaced instead.
 */
function describeError(err: unknown, chunkFailed: boolean): string {
  if (chunkFailed) return '三维引擎加载失败，请检查网络连接后重试'
  const detail = err instanceof Error ? err.message : String(err)
  return `三维视图初始化失败：${detail}`
}

// Only referenced as a type here (`typeof import(...)`), never as a runtime
// value -- this is erased entirely at compile time, so it does NOT create a
// static import of trackEntities.ts/cpEntities.ts/flythrough.ts (all three
// import `cesium`). All three modules are only ever loaded at runtime via
// the dynamic `import()` in the mount effect below, alongside
// `cesium/viewer`, keeping all four confined to the lazy chunk exactly like
// N1 established for `cesium/viewer` alone.
type TrackEntitiesModule = typeof import('../cesium/trackEntities')
type CpEntitiesModule = typeof import('../cesium/cpEntities')
type FlythroughModule = typeof import('../cesium/flythrough')
type ContoursModule = typeof import('../cesium/contours')
type RadarProjectionModule = typeof import('../cesium/radarProjection')
type FrameExportModule = typeof import('../cesium/frameExport')

/**
 * Mounts only while appStore's `mode === 'fly'` (see App.tsx) -- the 2D
 * MapLibre view unmounts in the same swap, so only one map engine and one
 * WebGL context is ever alive at a time.
 *
 * Lifecycle mirrors map/MapView.tsx's mount-once/destroy-on-unmount
 * discipline, with one addition MapView doesn't need: `createViewer` is
 * async (it awaits the terrain fallback chain), so React 18 StrictMode's
 * double-invoked mount effect creates a real race -- the first invocation's
 * cleanup can run *before* its `createViewer` call resolves. `cancelled`
 * below is what makes that safe: a viewer that finishes constructing after
 * its own effect was already torn down gets destroyed immediately instead
 * of leaking a live WebGL context that nothing will ever clean up.
 */
export function FlyView() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const cps = useAppStore((s) => s.cps)
  const locateRequest = useAppStore((s) => s.locateRequest)
  const clearLocateRequest = useAppStore((s) => s.clearLocateRequest)
  const flythroughSpeed = useAppStore((s) => s.flythroughSpeed)
  const flythroughCameraMode = useAppStore((s) => s.flythroughCameraMode)
  const flyBasemapStyle = useAppStore((s) => s.flyBasemapStyle)
  const contoursEnabled = useAppStore((s) => s.contoursEnabled)
  const radarEnabled = useAppStore((s) => s.radarEnabled)

  // True while `basemap.setStyle` is mid-terrain-reload (see
  // `cesium/viewer.ts`'s `CesiumBasemapHandle#setStyle` doc comment):
  // swapping `terrainProvider` discards every previously-loaded terrain tile
  // and triggers a full re-request, so without some indication the scene
  // just appears to freeze for the couple of seconds that takes.
  const [basemapLoading, setBasemapLoading] = useState(false)

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  // Refs mirroring the latest store values, for the same reason MapView.tsx
  // keeps its own tracksRef/etc.: the mount effect's callbacks (the
  // createViewer .then() chain, the ResizeObserver handler) are registered
  // once and must still see current data whenever they eventually fire.
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const activeTrackIdRef = useRef(activeTrackId)
  activeTrackIdRef.current = activeTrackId
  const cpsRef = useRef(cps)
  cpsRef.current = cps
  // Mirrors `radarEnabled` for the onProgress closure below (registered once
  // per engine, must always see the current toggle) -- same reasoning as
  // every other *Ref mirror in this file. Read here rather than skipped
  // entirely so the per-tick projection work (cesium/radarProjection.ts) is
  // only ever done while the overlay is actually visible.
  const radarEnabledRef = useRef(radarEnabled)
  radarEnabledRef.current = radarEnabled

  // Populated once the viewer/trackEntities/cpEntities chunk has loaded and
  // the Viewer itself exists -- the later effects (track sync, CP sync,
  // locate) all gate on this being set, exactly like MapView.tsx gates on
  // its own `loadedRef`.
  const viewerHandleRef = useRef<CesiumViewerHandle | undefined>(undefined)
  const entitiesModRef = useRef<TrackEntitiesModule | undefined>(undefined)
  const cpModRef = useRef<CpEntitiesModule | undefined>(undefined)
  const flythroughModRef = useRef<FlythroughModule | undefined>(undefined)
  const contoursModRef = useRef<ContoursModule | undefined>(undefined)
  const radarProjectionModRef = useRef<RadarProjectionModule | undefined>(undefined)
  const frameExportModRef = useRef<FrameExportModule | undefined>(undefined)

  // The one live contour-overlay handle, if any -- created once the viewer
  // exists (see the mount effect's `.then(h)` below) and destroyed alongside
  // it. Unlike `engineRef`, this is never rebuilt per-track: contours are a
  // globe-level overlay, not something tied to any particular track.
  const contourHandleRef = useRef<ContourHandle | undefined>(undefined)

  // The one live FlythroughEngine, if any -- undefined whenever there is no
  // active track (or the viewer/chunk isn't ready yet). `rebuildFlythrough`
  // below is the single place that creates/destroys it, so `engineRef` is
  // always either undefined or an engine matching the *current* active
  // track, never a stale one left over from a previous track.
  const engineRef = useRef<FlythroughEngine | undefined>(undefined)

  // Imperative handles for the frame-rate-driven overlays (N4's HUD/
  // checkpoint card, N6 commit 4's radar) -- updated directly from the
  // engine's onProgress callback below, NOT via React props/state, so a
  // 60Hz playback never re-renders their subtrees (see HudOverlay.tsx/
  // CheckpointCard.tsx's own doc comments for the full reasoning).
  // `setProgressInfo` below still drives FlyControls exactly as before N4 --
  // these are additional, not replacement, listeners.
  const hudRef = useRef<HudOverlayHandle>(null)
  const cpCardRef = useRef<CheckpointCardHandle>(null)
  const radarRef = useRef<RadarOverlayHandle>(null)

  // The one live export handle, if any (P1 milestone N5, replaced by P2 §3.4
  // milestone Q4's `frameExport.ts` -- see that module's own file comment
  // for why this is one handle regardless of which underlying pipeline,
  // deterministic or MediaRecorder-fallback, ends up running). Not a React
  // ref-to-component, just a plain mutable slot for the same "must survive
  // re-renders, driven imperatively from onProgress" reason engineRef is one.
  const exportRef = useRef<ExportHandle | undefined>(undefined)
  const [exportProgress, setExportProgress] = useState<ExportProgressInfo | undefined>(undefined)
  const [exportMode, setExportMode] = useState<ExportMode | undefined>(undefined)
  const [exportModeDetail, setExportModeDetail] = useState<string | undefined>(undefined)
  const [exportError, setExportError] = useState<string | undefined>(undefined)
  const [exportResolutionKey, setExportResolutionKey] = useState<ExportResolutionKey>('16:9-1080p')

  // High-frequency playback telemetry (progress/mileage/point index),
  // pushed by the engine's onProgress callback -- up to once per rendered
  // frame while playing. Kept as local component state rather than in
  // appStore deliberately (see appStore.ts's `flythroughSpeed` doc comment
  // for why): only FlyControls (a child of this component) needs it, so
  // there is no reason to fan it out through the global store.
  const [progressInfo, setProgressInfo] = useState<FlythroughProgressInfo | undefined>(undefined)
  // Mirrors the live engine's readonly `syntheticTimeline` flag into actual
  // React state (set once, whenever `rebuildFlythrough` runs) rather than
  // reading `engineRef.current.syntheticTimeline` straight from the ref
  // during render -- refs aren't supposed to drive render output, and while
  // it happens to be safe here (every `engineRef` mutation is paired with a
  // `setProgressInfo` call that forces a re-render before paint), this
  // avoids relying on that coincidence.
  const [syntheticTimeline, setSyntheticTimeline] = useState(false)

  /**
   * Tears down whatever engine is currently live (idempotent -- see
   * `FlythroughEngine.destroy`'s own doc comment) and, if `track` and the
   * viewer/chunk are both ready, builds a fresh one for it. Called both
   * inline (once, right after the viewer/chunk first become ready -- see
   * the mount effect below) and from the `activeTrack`-keyed effect for
   * every subsequent track switch, so this is the single place engine
   * construction/destruction happens; nothing else touches `engineRef`
   * directly. New speed/camera-mode settings are applied from the store's
   * *current* values (not the possibly-stale ones captured in a closure),
   * so a track rebuilt mid-session still starts with whatever the user last
   * selected in FlyControls.
   */
  function rebuildFlythrough(handle: CesiumViewerHandle, track: Track | undefined): void {
    // An export (P1 milestone N5 / P2 milestone Q4) is tied to one specific
    // engine/track -- rebuilding the engine out from under it (a track
    // switch mid-export) would otherwise leave the export pipeline driving a
    // destroyed FlythroughEngine. Single choke point, since this function is
    // the only place that ever replaces engineRef (see this function's own
    // doc comment).
    exportRef.current?.cancel()
    exportRef.current = undefined
    engineRef.current?.destroy()
    engineRef.current = undefined
    setProgressInfo(undefined)
    setSyntheticTimeline(false)

    const mod = flythroughModRef.current
    if (!track || !mod) return

    const engine = new mod.FlythroughEngine(handle.viewer, track, {
      onProgress: (info) => {
        setProgressInfo(info)
        // Bypasses React entirely -- see the hudRef/cpCardRef doc comment
        // above. Both refs are no-ops (optional chaining) until their
        // components have mounted, which is fine: HudOverlay/CheckpointCard
        // each separately paint their own "at the start" state on mount
        // (see their own effects) rather than depending on catching this
        // exact first synchronous call.
        hudRef.current?.update(info)
        cpCardRef.current?.update(info)
        // Radar (milestone N6 commit 4; checkpoint targets/next-checkpoint
        // readout added as a P1 follow-up): only does the projection/target
        // work at all while the overlay is actually enabled (radarEnabledRef,
        // not a stale closed-over `radarEnabled`, since this callback is
        // registered once per engine and must see later toggle changes) --
        // `handle.viewer` (not a re-read of `viewerHandleRef.current`) is
        // exactly the viewer this engine belongs to, and `rebuildFlythrough`
        // is always called with the same `handle` those two would otherwise
        // just duplicate. `track` is this closure's own parameter (the exact
        // track this engine was built for, never stale), matching how `mod`
        // above is captured. The gain prefix array comes from
        // `getHudTrackStats`, the SAME cache `HudOverlay.tsx` already
        // populates for its own ascent figure -- reusing that one cache entry
        // (see radarTargets.ts's file comment) instead of a second
        // O(track length) pass just for the radar.
        if (radarEnabledRef.current) {
          const radarMod = radarProjectionModRef.current
          const projection = radarMod ? radarMod.projectRadarCenter(handle.viewer) : undefined
          const stats = getHudTrackStats(track, useAppStore.getState().statsOptions)
          const targets = buildRadarTargets(track, cpsRef.current, info.pointIndex, projection?.headingRad ?? 0, stats.gain)
          radarRef.current?.update(projection, targets)
        }
        // Video export (P1 milestone N5, P2 milestone Q4): the SAME
        // onProgress tick feeds the compositor's overlay content (and, for
        // the MediaRecorder fallback path, detects auto-stop-at-end) -- see
        // cesium/frameExport.ts's own doc comment. A no-op whenever no
        // export is in progress (exportRef.current is undefined).
        exportRef.current?.onProgress(info)
      },
    })
    const s = useAppStore.getState()
    engine.setSpeed(s.flythroughSpeed)
    engine.setCameraMode(s.flythroughCameraMode)
    engineRef.current = engine
    setSyntheticTimeline(engine.syntheticTimeline)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let handle: CesiumViewerHandle | undefined
    let chunkFailed = true // flipped to false once the dynamic import() itself resolves

    // All seven cesium-touching modules load together, off the same dynamic
    // import() boundary -- none of trackEntities.ts/cpEntities.ts/
    // flythrough.ts/contours.ts/radarProjection.ts/frameExport.ts (which
    // itself dynamically-imports-equivalent recorder.ts/deterministicRenderer.ts/
    // videoEncoder.ts as ordinary static imports, since ALL of them only
    // ever get reached from inside this same chunk) must ever be statically
    // imported from outside this file (see the TrackEntitiesModule/
    // CpEntitiesModule/FlythroughModule/ContoursModule/
    // RadarProjectionModule/FrameExportModule comment above) or `cesium`/
    // `mp4-muxer` would re-enter the main bundle.
    Promise.all([
      import('../cesium/viewer'),
      import('../cesium/trackEntities'),
      import('../cesium/cpEntities'),
      import('../cesium/flythrough'),
      import('../cesium/contours'),
      import('../cesium/radarProjection'),
      import('../cesium/frameExport'),
    ])
      .then(([viewerMod, entitiesMod, cpMod, flythroughMod, contoursMod, radarProjectionMod, frameExportMod]) => {
        chunkFailed = false
        entitiesModRef.current = entitiesMod
        cpModRef.current = cpMod
        flythroughModRef.current = flythroughMod
        contoursModRef.current = contoursMod
        radarProjectionModRef.current = radarProjectionMod
        frameExportModRef.current = frameExportMod
        return viewerMod.createViewer(container)
      })
      .then((h) => {
        if (cancelled) {
          // The effect was torn down (StrictMode's double-invoke, or the
          // user already flipped back to 规划模式) while creation was still
          // in flight -- do not hand this viewer to setState, and do not
          // rely on the *next* mount's destroy() call to clean it up.
          h.destroy()
          return
        }
        handle = h
        viewerHandleRef.current = h
        setState({ status: 'ready', providers: h.providers })
        // Applies the persisted per-mode basemap style (milestone N6 commit
        // 1) once the Viewer exists -- createViewer itself only ever applies
        // `DEFAULT_BASEMAP_STYLE` (see its own doc comment on why), so
        // without this a user who last chose 二维平面图 for 巡游模式 would
        // see satellite imagery again on every fresh flythrough session.
        h.basemap.setStyle(useAppStore.getState().flyBasemapStyle, (loading) => setBasemapLoading(loading))
        // Wires the contour overlay (milestone N6 commit 3) to this Viewer,
        // applying whatever the persisted basemap style / layerPrefs.ts
        // toggle currently say -- same "apply the persisted value once here,
        // react to later changes via the effects below" split as the
        // basemap-style line just above.
        const contoursMod = contoursModRef.current
        if (contoursMod) {
          const contourHandle = contoursMod.attachContours(h.viewer, useAppStore.getState().flyBasemapStyle)
          contourHandle.setEnabled(useAppStore.getState().contoursEnabled)
          contourHandleRef.current = contourHandle
        }
        // First sync as soon as the viewer exists, using whatever
        // tracks/cps/activeTrackId are current right now -- the effects
        // below only re-run on a *subsequent* change, so without this the
        // initially-loaded tracks/CPs would never render until the next
        // store update. Also flies to the newest track the very first time
        // it appears, same as syncTrackLayers does for the 2D map (see
        // trackEntities.ts's `pendingFlyTo`).
        entitiesModRef.current?.syncTrackEntities(h.viewer, tracksRef.current, activeTrackIdRef.current)
        cpModRef.current?.syncCpEntities(h.viewer, cpsRef.current, tracksRef.current, activeTrackIdRef.current)
        // Same "first build inline, subsequent changes via effect" split as
        // the track/CP sync above, and for the identical reason: the
        // effect watching `activeTrack` (below) only fires on a
        // *subsequent* change, so without this the flythrough engine for
        // an already-active track would never get built.
        const track = tracksRef.current.find((t) => t.id === activeTrackIdRef.current)
        rebuildFlythrough(h, track)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ status: 'error', message: describeError(err, chunkFailed) })
      })

    // Cesium's own render loop re-measures its canvas and self-corrects on
    // every frame it renders -- but viewer.ts constructs it with
    // `requestRenderMode: true`, so nothing re-renders (and nothing
    // re-measures) until something requests a frame. A track's initial
    // camera fly-to can therefore race the container's flex layout the
    // exact same way MapLibre's fitBounds does in trackLayer.ts (this app's
    // `app-layout__map` div has no guaranteed non-zero size on the very
    // first layout pass) -- see trackEntities.ts's `tryPendingFlyTo` for the
    // full explanation. This mirrors MapView.tsx's own ResizeObserver
    // exactly, just retrying a pending fly-to instead of a pending fitBounds.
    const ro = new ResizeObserver(() => {
      const h = viewerHandleRef.current
      const mod = entitiesModRef.current
      if (!h || !mod) return
      mod.tryPendingFlyTo(h.viewer, tracksRef.current)
    })
    ro.observe(container)

    return () => {
      cancelled = true
      ro.disconnect()
      // Cancel any in-progress export BEFORE tearing down the engine/viewer
      // it's exporting -- recorder.ts/deterministicRenderer.ts both tolerate
      // an already-destroyed Viewer internally (see their own doc
      // comments), but there is no reason to let either keep running against
      // a Viewer that's about to disappear out from under it.
      exportRef.current?.cancel()
      exportRef.current = undefined
      // Destroy the engine BEFORE the viewer -- not that order actually
      // matters for correctness (FlythroughEngine.destroy() tolerates an
      // already-destroyed Viewer, see its own doc comment), but destroying
      // it first means it still gets a chance to do its own cleanup
      // (removing listeners it added) against a live Viewer rather than
      // relying on the Viewer's teardown to have implicitly discarded them.
      engineRef.current?.destroy()
      engineRef.current = undefined
      contourHandleRef.current?.destroy()
      contourHandleRef.current = undefined
      viewerHandleRef.current = undefined
      handle?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-sync track entities whenever the track list or active track changes,
  // mirroring MapView.tsx's own tracks/activeTrackId effect.
  useEffect(() => {
    const h = viewerHandleRef.current
    const mod = entitiesModRef.current
    if (!h || !mod) return
    mod.syncTrackEntities(h.viewer, tracks, activeTrackId)
  }, [tracks, activeTrackId])

  // Re-sync CP entities whenever the CP list, the track list, or the active
  // track changes -- cpEntities.ts resolves each CP's position against
  // `activeTrackId`'s own Track data (via anchorIndex), so a toolbox op
  // that replaces the active track (new coordinates at the same indices)
  // must trigger this too, not just an actual cps-array change. Mirrors
  // MapView.tsx's own CP-marker effect.
  useEffect(() => {
    const h = viewerHandleRef.current
    const mod = cpModRef.current
    if (!h || !mod) return
    mod.syncCpEntities(h.viewer, cps, tracks, activeTrackId)
  }, [cps, tracks, activeTrackId])

  // Rebuilds the flythrough engine whenever the active *Track object*
  // changes -- covers every subsequent track switch (the initial build for
  // whatever track is already active on mount happens inline in the mount
  // effect's `.then()`, for the same reason `syncTrackEntities`'s first
  // call does: this effect's dependency array doesn't change just because
  // the viewer transitioned from not-ready to ready). Reference identity
  // (not just id) is the right comparison here, matching every other
  // Track-keyed cache in this codebase (trackEntities.ts's geometryCache,
  // etc.): a toolbox op replaces the active track with a brand-new object
  // at the same id, and the engine's camera path must be rebuilt from that
  // new geometry, not silently keep flying through stale positions.
  useEffect(() => {
    const h = viewerHandleRef.current
    if (!h) return
    rebuildFlythrough(h, activeTrack)
    return () => {
      engineRef.current?.destroy()
      engineRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrack])

  // Propagates speed/camera-mode changes from appStore into whichever
  // engine is currently live -- the engine itself only reads these once,
  // at construction (see rebuildFlythrough), so without this a user
  // changing speed/mode mid-flight in FlyControls would have no effect
  // until the next track switch happened to rebuild the engine.
  useEffect(() => {
    engineRef.current?.setSpeed(flythroughSpeed)
  }, [flythroughSpeed])

  useEffect(() => {
    engineRef.current?.setCameraMode(flythroughCameraMode)
  }, [flythroughCameraMode])

  // Propagates a later basemap-style change (LayerPanel, milestone N6
  // commit 1) into the live viewer -- the initial style is applied once,
  // inline, right after `createViewer` resolves (see the mount effect
  // above); this only fires on a *subsequent* change, same split as the
  // speed/camera-mode effects above. No-ops until the viewer is ready
  // (`viewerHandleRef.current` is still undefined at the moment this effect
  // first runs on mount, since `createViewer` is async).
  useEffect(() => {
    const h = viewerHandleRef.current
    if (!h) return
    h.basemap.setStyle(flyBasemapStyle, (loading) => setBasemapLoading(loading))
  }, [flyBasemapStyle])

  // Keeps the contour overlay's basemap-style preset (milestone N6 commit 3)
  // in sync with the same basemap-style changes the effect above applies to
  // the Viewer -- two independent effects (rather than one combined) since
  // `attachContours`'s handle only exists once the viewer/chunk are ready,
  // same "no-op until ready" gate as every other post-mount effect here.
  useEffect(() => {
    contourHandleRef.current?.setBasemapStyle(flyBasemapStyle)
  }, [flyBasemapStyle])

  // Propagates the LayerPanel contours on/off toggle into the live handle.
  useEffect(() => {
    contourHandleRef.current?.setEnabled(contoursEnabled)
  }, [contoursEnabled])

  // Acts on the "定位" (locate) request from a TrackList row, the same
  // `locateRequest`/`requestLocate` mechanism MapView.tsx's own effect
  // consumes for the 2D map -- see appStore's doc comment on `locateRequest`
  // for why this is keyed on `seq`, not just `trackId`. Always clears the
  // request afterwards, even if there was nothing usable to act on yet
  // (viewer not ready, or the track was deleted in the meantime), so a
  // stale request can't be replayed by some unrelated re-render.
  useEffect(() => {
    if (!locateRequest) return
    const h = viewerHandleRef.current
    const mod = entitiesModRef.current
    if (h && mod) {
      const track = tracksRef.current.find((t) => t.id === locateRequest.trackId)
      if (track) mod.flyToTrack(h.viewer, track)
    }
    clearLocateRequest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateRequest?.seq])

  /**
   * Starts exporting the flythrough (P1 milestone N5, P2 §3.4 milestone
   * Q4) -- disabled from `FlyControls` unless the viewer/engine/track are
   * all ready (mirrors every other engine-driving handler here).
   * `statsOptions` is read fresh from the store at click time rather than
   * subscribed to, the same one-shot-read convention `rebuildFlythrough`
   * already uses for `flythroughSpeed`/`flythroughCameraMode`.
   * `frameExport.ts#startExport` itself decides, asynchronously, whether the
   * deterministic WebCodecs/MP4 pipeline or the MediaRecorder fallback ends
   * up running -- see that module's file comment.
   */
  function handleStartExport(): void {
    const h = viewerHandleRef.current
    const engine = engineRef.current
    const mod = frameExportModRef.current
    if (!h || !engine || !activeTrack || !mod) return
    setExportError(undefined)
    setExportMode(undefined)
    setExportModeDetail(undefined)
    exportRef.current = mod.startExport({
      viewer: h.viewer,
      engine,
      track: activeTrack,
      cps: cpsRef.current,
      statsOptions: useAppStore.getState().statsOptions,
      radarEnabled: radarEnabledRef.current,
      resolution: EXPORT_RESOLUTIONS[exportResolutionKey],
      // Compliance credits tail (P2 §3.4 Q5 commit 3) -- `h.providers` is
      // the SAME `ProviderReport` the corner badge below already renders
      // (`state.providers`), read straight off the handle instead of from
      // component state so this stays correct even if `state` hasn't
      // re-rendered yet. `flyBasemapStyle` is read fresh at click time, the
      // same one-shot-read convention `statsOptions` above already uses.
      providers: h.providers,
      basemapStyle: useAppStore.getState().flyBasemapStyle,
      onProgress: setExportProgress,
      onModeChosen: (mode, detail) => {
        setExportMode(mode)
        setExportModeDetail(detail)
      },
      onError: (message) => {
        setExportError(message)
      },
      onDone: () => {
        exportRef.current = undefined
        setExportProgress(undefined)
      },
    })
  }

  function handleCancelExport(): void {
    exportRef.current?.cancel()
  }

  return (
    <div className="fly-view">
      <div ref={containerRef} className="fly-view__container" />
      {state.status === 'loading' && (
        <div className="fly-view__overlay" role="status">
          <p>正在加载三维引擎…</p>
        </div>
      )}
      {state.status === 'error' && (
        <div className="fly-view__overlay fly-view__overlay--error" role="alert">
          <p>{state.message}</p>
        </div>
      )}
      {state.status === 'ready' && (
        <div className="fly-view__badge" role="status">
          {basemapLoading
            ? '正在切换底图…'
            : <>地形：{TERRAIN_LABEL[state.providers.terrain]} · 影像：{IMAGERY_LABEL[state.providers.imagery]}</>}
        </div>
      )}
      {state.status === 'ready' && (
        <FlyOverlayLayer>
          <HudOverlay ref={hudRef} track={activeTrack} />
          <CheckpointCard ref={cpCardRef} track={activeTrack} cps={cps} />
          <RadarOverlay ref={radarRef} enabled={radarEnabled} />
        </FlyOverlayLayer>
      )}
      {state.status === 'ready' && (
        <FlyControls
          hasActiveTrack={activeTrack !== undefined}
          syntheticTimeline={syntheticTimeline}
          progress={progressInfo}
          onTogglePlay={() => engineRef.current?.togglePlay()}
          onSeek={(progress) => engineRef.current?.seek(progress)}
          exportProgress={exportProgress}
          exportMode={exportMode}
          exportModeDetail={exportModeDetail}
          exportError={exportError}
          exportResolutionKey={exportResolutionKey}
          onExportResolutionChange={setExportResolutionKey}
          onStartExport={handleStartExport}
          onCancelExport={handleCancelExport}
        />
      )}
    </div>
  )
}
