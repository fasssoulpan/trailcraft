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
  const c = map.getCenter()
  const canvas = map.getCanvas()
  return {
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

export function MapDebugBadge() {
  const [info, setInfo] = useState<MapDebugInfo | undefined>(undefined)

  useEffect(() => {
    const id = window.setInterval(() => setInfo(readMapDebugInfo()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (!info) {
    return (
      <div className="map-debug-badge">
        <strong>地图诊断</strong>
        <div>未找到地图实例(可能当前是巡游模式)</div>
      </div>
    )
  }

  return (
    <div className="map-debug-badge">
      <strong>地图诊断</strong>
      <div>样式已加载: {String(info.styleLoaded)}</div>
      <div>全部图层: {info.layerIds.length > 0 ? info.layerIds.join(', ') : '(空)'}</div>
      <div>轨迹图层: {info.trackLayers.length > 0 ? info.trackLayers.join(', ') : '(无)'}</div>
      <div>轨迹坐标点数: {info.trackCoordCounts.map((n) => String(n ?? '?')).join(', ') || '—'}</div>
      <div>渲染中的轨迹要素: {info.renderedTrackFeatures}</div>
      <div>轨迹 paint: {JSON.stringify(info.trackPaint)}</div>
      <div>
        中心 {info.center} · 缩放 {info.zoom} · 画布 {info.canvas}
      </div>
    </div>
  )
}
