import { useEffect, useRef, useState } from 'react'
import type { CesiumViewerHandle, ProviderReport } from '../cesium/viewer'

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

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let handle: CesiumViewerHandle | undefined
    let chunkFailed = true // flipped to false once the dynamic import() itself resolves

    import('../cesium/viewer')
      .then((mod) => {
        chunkFailed = false
        return mod.createViewer(container)
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
        setState({ status: 'ready', providers: h.providers })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ status: 'error', message: describeError(err, chunkFailed) })
      })

    return () => {
      cancelled = true
      handle?.destroy()
    }
  }, [])

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
