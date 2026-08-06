import { useEffect, useRef } from 'react'
import {
  Map as MapLibreMap,
  NavigationControl,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAppStore, type HoverState } from '../state/appStore'
import { findNearestOnTrack, pixelsToMeters, syncHoverMarker, syncTrackLayers, HOVER_GRAB_PX } from './trackLayer'

/**
 * Raster OSM basemap style. Exported as a constant so the tile URL is easy
 * to swap out: OpenStreetMap's own tile CDN (tile.openstreetmap.org) is
 * slow/unreliable to reach from mainland China, which is TrailCraft's
 * target market, so this is expected to become a user- or env-configurable
 * URL (e.g. pointing at a China-reachable mirror or self-hosted tiles) in a
 * later task rather than staying hardcoded.
 */
export const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

// Roughly the center of China, used only as the pre-track-load default view.
const DEFAULT_CENTER: [number, number] = [104.0, 35.0]
const DEFAULT_ZOOM = 3

export function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const loadedRef = useRef(false)

  const tracks = useAppStore((s) => s.tracks)
  const hover = useAppStore((s) => s.hover)
  const setHover = useAppStore((s) => s.setHover)

  // Refs mirroring the latest props/state so long-lived callbacks (the
  // MapLibre 'load' handler registered once in the mount effect, the
  // rAF-throttled mousemove handler) always see current data without
  // needing to be re-registered on every tracks/hover change.
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  const setHoverRef = useRef(setHover)
  setHoverRef.current = setHover

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

    const handleLoad = () => {
      loadedRef.current = true
      syncTrackLayers(map, tracksRef.current)
      syncHoverMarker(map, tracksRef.current, hoverRef.current)
    }
    map.on('load', handleLoad)

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

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      map.off('load', handleLoad)
      map.off('mousemove', handleMouseMove)
      map.off('mouseout', handleMouseOut)
      map.remove()
      mapRef.current = null
      loadedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-sync track layers whenever the track list changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!map.isStyleLoaded()) return // the 'load' handler above will pick up tracksRef.current once it fires
    syncTrackLayers(map, tracks)
  }, [tracks])

  // Re-sync the hover marker whenever hover state changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!map.isStyleLoaded()) return
    syncHoverMarker(map, tracks, hover)
  }, [tracks, hover])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
