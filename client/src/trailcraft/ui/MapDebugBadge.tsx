import { useEffect, useState } from 'react'

/**
 * Dev-only on-screen readout of the 2D map's actual layer/source state.
 *
 * Exists because "the track doesn't draw" is otherwise very hard to diagnose
 * remotely: the MapLibre instance is only reachable by walking React's fiber
 * tree, and Chrome blocks pasting into its console by default. This renders
 * the same facts directly on the page. Stripped from production builds by the
 * `import.meta.env.DEV` guard at its usage site in App.tsx.
 */
interface MapDebugInfo {
  styleLoaded: boolean
  layerIds: string[]
  trackLayers: string[]
  trackCoordCounts: (number | undefined)[]
  renderedTrackFeatures: number
  trackPaint: unknown[]
  sourceLoaded: (boolean | undefined)[]
  errors: string[]
  center: string
  zoom: string
  canvas: string
}

function readMapDebugInfo(): MapDebugInfo | undefined {
  const map = (window as unknown as { __trailcraftMap?: MapLikeForDebug }).__trailcraftMap
  if (!map) return undefined
  let style: { layers?: { id: string; paint?: unknown }[] } | undefined
  try {
    style = map.getStyle() as typeof style
  } catch {
    style = undefined
  }
  const layers = style?.layers ?? []
  const trackLayers = layers.filter((l) => l.id.startsWith('trk-'))
  const ids = trackLayers.map((l) => l.id)
  let rendered = 0
  try {
    rendered = ids.length > 0 ? map.queryRenderedFeatures({ layers: ids }).length : 0
  } catch {
    rendered = -1
  }
  // A GeoJSON source only reports loaded() once MapLibre's worker has parsed
  // its data into vector tiles. A raster basemap needs no worker at all, so
  // "raster paints, GeoJSON never loads" is the signature of a broken worker
  // -- which would also keep isStyleLoaded() false forever and make
  // queryRenderedFeatures return nothing.
  const sourceLoaded = ids.map((id) => {
    const src = map.getSource(id) as { loaded?: () => boolean } | undefined
    try {
      return typeof src?.loaded === 'function' ? src.loaded() : undefined
    } catch {
      return undefined
    }
  })
  const errors = (window as unknown as { __trailcraftMapErrors?: string[] }).__trailcraftMapErrors ?? []
  const c = map.getCenter()
  const canvas = map.getCanvas()
  return {
    sourceLoaded,
    errors: errors.slice(-3),
    styleLoaded: map.isStyleLoaded(),
    layerIds: layers.map((l) => l.id),
    trackLayers: ids,
    trackCoordCounts: ids.map((id) => {
      const src = map.getSource(id) as SourceLikeForDebug | undefined
      const data = src?._data
      const geo = data && 'geojson' in data ? data.geojson : data
      return geo?.geometry?.coordinates?.length
    }),
    renderedTrackFeatures: rendered,
    trackPaint: trackLayers.map((l) => l.paint),
    center: `${c.lng.toFixed(4)}, ${c.lat.toFixed(4)}`,
    zoom: map.getZoom().toFixed(2),
    canvas: `${canvas.clientWidth}x${canvas.clientHeight}`,
  }
}

interface MapLikeForDebug {
  getStyle(): unknown
  isStyleLoaded(): boolean
  queryRenderedFeatures(opts: { layers: string[] }): unknown[]
  getSource(id: string): unknown
  getCenter(): { lng: number; lat: number }
  getZoom(): number
  getCanvas(): HTMLCanvasElement
}

interface SourceLikeForDebug {
  _data?: {
    geojson?: { geometry?: { coordinates?: unknown[] } }
    geometry?: { coordinates?: unknown[] }
  }
}

const PROBE_ID = '__debug_probe_line'

/**
 * Adds a trivial 2-point GeoJSON line completely independent of TrailCraft's
 * own track code, then reports whether MapLibre ever finishes loading it.
 * This isolates "MapLibre's GeoJSON pipeline (its worker) is broken in this
 * build" from "our track-layer code is wrong" -- a raster basemap needs no
 * worker, so it paints either way and cannot distinguish the two.
 */
async function runWorkerProbe(setResult: (s: string) => void) {
  const map = (window as unknown as { __trailcraftMap?: MapLikeForDebug & Record<string, unknown> })
    .__trailcraftMap
  if (!map) return setResult('未找到地图实例')
  const m = map as unknown as {
    getSource(id: string): unknown
    removeLayer(id: string): void
    removeSource(id: string): void
    addSource(id: string, spec: unknown): void
    addLayer(spec: unknown): void
    getCenter(): { lng: number; lat: number }
  }
  try {
    if (m.getSource(PROBE_ID)) {
      m.removeLayer(PROBE_ID)
      m.removeSource(PROBE_ID)
    }
    const c = m.getCenter()
    m.addSource(PROBE_ID, {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [c.lng - 0.05, c.lat - 0.05],
            [c.lng + 0.05, c.lat + 0.05],
          ],
        },
      },
    })
    m.addLayer({
      id: PROBE_ID,
      type: 'line',
      source: PROBE_ID,
      paint: { 'line-color': '#00ff00', 'line-width': 6 },
    })
    setResult('已加入测试线(绿色斜线),等待解析…')
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const src = m.getSource(PROBE_ID) as { loaded?: () => boolean } | undefined
      if (src && typeof src.loaded === 'function' && src.loaded()) {
        return setResult('✓ Worker 正常:测试线已解析。若屏幕上看不到绿线,则是渲染/视野问题')
      }
    }
    setResult('✗ Worker 异常:5 秒内测试线未完成解析 —— MapLibre 的 GeoJSON 管线有问题')
  } catch (e) {
    setResult('探针失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}

export function MapDebugBadge() {
  const [info, setInfo] = useState<MapDebugInfo | undefined>(undefined)
  const [probe, setProbe] = useState<string>('')
  // Collapsed by default: this covers a good part of the map, and it is only
  // wanted when something is actually wrong.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setInfo(readMapDebugInfo()), 1000)
    return () => window.clearInterval(id)
  }, [open])

  if (!open) {
    return (
      <button type="button" className="map-debug-badge__toggle" onClick={() => setOpen(true)}>
        地图诊断
      </button>
    )
  }

  if (!info) {
    return (
      <div className="map-debug-badge">
        <strong>地图诊断</strong>
        <div>未找到地图实例(可能当前是巡游模式)</div>
      </div>
    )
  }

  const hasLayer = info.trackLayers.length > 0
  const coords = info.trackCoordCounts[0] ?? 0
  const hasData = coords > 0
  const rendered = info.renderedTrackFeatures

  // A single plain-language conclusion, so diagnosing this remotely needs one
  // glance rather than reading raw JSON off a screenshot.
  let verdict: string
  const srcLoaded = info.sourceLoaded[0]
  if (!hasLayer) verdict = '① 轨迹图层不存在 —— 图层没加上或被样式切换冲掉'
  else if (!hasData) verdict = '② 图层在,但数据为空 —— 坐标没写进 source'
  else if (srcLoaded === false)
    verdict = '④ GeoJSON 源未完成解析 —— MapLibre Worker 未能把数据切成瓦片'
  else if (rendered === 0) verdict = '③ 图层和数据都在,但没渲染 —— 层序/可见性/视野问题'
  else verdict = `✓ 正常:图层在、${coords} 个点、${rendered} 个要素在渲染`

  const trkIndex = info.layerIds.findIndex((id) => id.startsWith('trk-'))

  return (
    <div className="map-debug-badge">
      <strong>
        地图诊断
        <button type="button" className="map-debug-badge__close" onClick={() => setOpen(false)}>
          收起
        </button>
      </strong>
      <div className="map-debug-badge__verdict">{verdict}</div>
      <div>
        图层 {hasLayer ? '有' : '无'} · 点数 {coords} · 渲染要素 {rendered}
      </div>
      <div>
        图层顺序 [{info.layerIds.join(' | ')}] · 轨迹排第 {trkIndex + 1}/{info.layerIds.length}
      </div>
      <div>
        样式已加载 {String(info.styleLoaded)} · 缩放 {info.zoom} · 画布 {info.canvas}
      </div>
      <div>
        源已解析 {info.sourceLoaded.map((b) => String(b)).join(', ') || '—'} · 中心 {info.center}
      </div>
      <div>paint {JSON.stringify(info.trackPaint)}</div>
      {info.errors.length > 0 ? <div>地图错误: {info.errors.join(' ‖ ')}</div> : null}
      <div className="map-debug-badge__actions">
        <button type="button" onClick={() => void runWorkerProbe(setProbe)}>
          测试 Worker
        </button>
        {probe ? <span> {probe}</span> : null}
      </div>
    </div>
  )
}
