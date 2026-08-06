import { parseGpx } from '../parsers/gpx'
import { parseKml } from '../parsers/kml'
import { parseFit } from '../parsers/fit'
import { detectCrs, type DetectResult } from '../crs/detect'
import { convertTrackArrays } from '../crs/transform'
import { computeCumDist } from '../geo/distance'
import type { Crs, Track } from '../model/track'

export interface ImportResult { track: Track; detect: DetectResult }

export async function importFile(
  fileName: string, data: string | ArrayBuffer,
  sourceMemory: Record<string, Crs>, forcedCrs?: Crs,
): Promise<ImportResult> {
  const ext = fileName.toLowerCase().split('.').pop()
  let track: Track
  if (ext === 'gpx') track = parseGpx(data as string, fileName)
  else if (ext === 'kml') track = parseKml(data as string, fileName)
  else if (ext === 'fit') track = await parseFit(data as ArrayBuffer, fileName)
  else throw new Error(`不支持的格式: ${ext}`)

  const detect = forcedCrs
    ? { crs: forcedCrs, confidence: 'high' as const, reason: 'user forced' }
    : detectCrs({ creator: track.meta.creator, fileName }, sourceMemory)

  if (detect.crs !== 'wgs84') {
    const { lon, lat } = convertTrackArrays(track.points.lon, track.points.lat, detect.crs, 'wgs84')
    track = { ...track, originalCrs: detect.crs, points: { ...track.points, lon, lat } }
  }
  track.points.cumDist = computeCumDist(track.points.lon, track.points.lat)
  return { track, detect }
}
