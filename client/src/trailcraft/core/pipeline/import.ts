import { parseGpx, parseGpxWaypoints, type GpxWaypoint } from '../parsers/gpx'
import { parseKml, parseKmlWaypoints, type KmlWaypoint } from '../parsers/kml'
import { parseFit } from '../parsers/fit'
import { detectCrs, type DetectResult } from '../crs/detect'
import { convertTrackArrays } from '../crs/transform'
import { computeCumDist } from '../geo/distance'
import type { Crs, Track } from '../model/track'

export type ImportedWaypoint = KmlWaypoint | GpxWaypoint
export interface ImportResult { track: Track; detect: DetectResult; waypoints: ImportedWaypoint[] }

function payloadTypeName(data: unknown): string {
  if (typeof data === 'string') return 'string'
  if (data instanceof ArrayBuffer) return 'ArrayBuffer'
  return Object.prototype.toString.call(data)
}

export async function importFile(
  fileName: string, data: string | ArrayBuffer,
  sourceMemory: Record<string, Crs>, forcedCrs?: Crs,
): Promise<ImportResult> {
  const ext = fileName.toLowerCase().split('.').pop()
  let track: Track
  // GPX `<wpt>` and KML `<Placemark><Point>` are both commonly used by race
  // organisers to encode CP/aid locations. Keep one structural result shape
  // so both formats share CRS conversion and the same monotonic CP anchoring.
  let waypoints: ImportedWaypoint[] = []
  if (ext === 'gpx' || ext === 'kml') {
    if (typeof data !== 'string')
      throw new Error(
        `${ext} 解析需要 string 类型的数据,实际收到 ${payloadTypeName(data)}: ${fileName}`,
      )
    if (ext === 'gpx') {
      track = parseGpx(data, fileName)
      waypoints = parseGpxWaypoints(data)
    } else {
      track = parseKml(data, fileName)
      waypoints = parseKmlWaypoints(data)
    }
  } else if (ext === 'fit') {
    if (!(data instanceof ArrayBuffer))
      throw new Error(
        `fit 解析需要 ArrayBuffer 类型的数据,实际收到 ${payloadTypeName(data)}: ${fileName}`,
      )
    track = await parseFit(data, fileName)
  } else {
    throw new Error(`不支持的格式: ${ext}`)
  }

  const detect = forcedCrs
    ? { crs: forcedCrs, confidence: 'high' as const, reason: 'user forced' }
    : detectCrs({ creator: track.meta.creator, fileName }, sourceMemory)

  if (detect.crs !== 'wgs84') {
    const { lon, lat } = convertTrackArrays(track.points.lon, track.points.lat, detect.crs, 'wgs84')
    track = { ...track, originalCrs: detect.crs, points: { ...track.points, lon, lat } }
    // Waypoints must go through the identical conversion as the track, or a
    // GCJ-02 source would leave them offset by hundreds of metres from the
    // (now-converted) track they're supposed to sit on.
    if (waypoints.length > 0) {
      const wLon = Float64Array.from(waypoints.map((w) => w.lon))
      const wLat = Float64Array.from(waypoints.map((w) => w.lat))
      const conv = convertTrackArrays(wLon, wLat, detect.crs, 'wgs84')
      waypoints = waypoints.map((w, i) => ({ ...w, lon: conv.lon[i], lat: conv.lat[i] }))
    }
  }
  track = { ...track, points: { ...track.points, cumDist: computeCumDist(track.points.lon, track.points.lat) } }
  return { track, detect, waypoints }
}
