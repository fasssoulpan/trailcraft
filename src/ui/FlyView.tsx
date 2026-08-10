import { useEffect, useRef, useState } from 'react'
import type { CesiumViewerHandle, ProviderReport } from '../cesium/viewer'
import { useAppStore } from '../state/appStore'

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
// static import of trackEntities.ts/cpEntities.ts (both of which import
// `cesium`). Both modules are only ever loaded at runtime via the dynamic
// `import()` in the mount effect below, alongside `cesium/viewer`, keeping
// all three confined to the lazy chunk exactly like N1 established for
// `cesium/viewer` alone.
type TrackEntitiesModule = typeof import('../cesium/trackEntities')
type CpEntitiesModule = typeof import('../cesium/cpEntities')

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

  // Populated once the viewer/trackEntities/cpEntities chunk has loaded and
  // the Viewer itself exists -- the later effects (track sync, CP sync,
  // locate) all gate on this being set, exactly like MapView.tsx gates on
  // its own `loadedRef`.
  const viewerHandleRef = useRef<CesiumViewerHandle | undefined>(undefined)
  const entitiesModRef = useRef<TrackEntitiesModule | undefined>(undefined)
  const cpModRef = useRef<CpEntitiesModule | undefined>(undefined)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let handle: CesiumViewerHandle | undefined
    let chunkFailed = true // flipped to false once the dynamic import() itself resolves

    // All three cesium-touching modules load together, off the same
    // dynamic import() boundary -- neither trackEntities.ts nor
    // cpEntities.ts must ever be statically imported (see the
    // TrackEntitiesModule/CpEntitiesModule comment above) or `cesium` would
    // re-enter the main bundle.
    Promise.all([import('../cesium/viewer'), import('../cesium/trackEntities'), import('../cesium/cpEntities')])
      .then(([viewerMod, entitiesMod, cpMod]) => {
        chunkFailed = false
        entitiesModRef.current = entitiesMod
        cpModRef.current = cpMod
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
        // First sync as soon as the viewer exists, using whatever
        // tracks/cps/activeTrackId are current right now -- the effects
        // below only re-run on a *subsequent* change, so without this the
        // initially-loaded tracks/CPs would never render until the next
        // store update. Also flies to the newest track the very first time
        // it appears, same as syncTrackLayers does for the 2D map (see
        // trackEntities.ts's `pendingFlyTo`).
        entitiesModRef.current?.syncTrackEntities(h.viewer, tracksRef.current, activeTrackIdRef.current)
        cpModRef.current?.syncCpEntities(h.viewer, cpsRef.current, tracksRef.current, activeTrackIdRef.current)
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
          地形：{TERRAIN_LABEL[state.providers.terrain]} · 影像：{IMAGERY_LABEL[state.providers.imagery]}
        </div>
      )}
    </div>
  )
}
