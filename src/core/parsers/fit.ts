import FitParser from 'fit-file-parser'
import { createTrack, type Track } from '../model/track'

/**
 * We deliberately decouple from fit-file-parser's own `ParsedRecord` type:
 * that package's shipped `.d.ts` declares `timestamp: string`, but at
 * runtime (see its `binary.js`) the field is actually populated with a
 * `Date` object. Rather than depend on that mismatch, we define the minimal
 * shape we consume and cast into it (see `parseFit` below).
 */
interface FitRecord {
  position_lat?: number
  position_long?: number
  altitude?: number
  timestamp?: Date
  heart_rate?: number
}

export function recordsToTrack(records: FitRecord[], fileName: string): Track {
  const lon: number[] = []
  const lat: number[] = []
  const ele: number[] = []
  const time: number[] = []
  const hr: number[] = []
  let hasEle = false
  let hasTime = false
  let hasHr = false
  for (const r of records) {
    if (typeof r.position_lat !== 'number' || typeof r.position_long !== 'number') continue
    lat.push(r.position_lat)
    lon.push(r.position_long)
    if (typeof r.altitude === 'number') { hasEle = true; ele.push(r.altitude) } else ele.push(NaN)
    if (r.timestamp) { hasTime = true; time.push(r.timestamp.getTime()) } else time.push(NaN)
    if (typeof r.heart_rate === 'number') { hasHr = true; hr.push(r.heart_rate) } else hr.push(0)
  }
  if (lon.length === 0) throw new Error(`FIT 无轨迹点: ${fileName}`)
  return createTrack(
    { lon, lat, ele: hasEle ? ele : undefined, time: hasTime ? time : undefined, hr: hasHr ? hr : undefined },
    { name: fileName.replace(/\.fit$/i, ''), format: 'fit', fileName },
  )
}

export function parseFit(buf: ArrayBuffer, fileName: string): Promise<Track> {
  return new Promise((resolve, reject) => {
    const p = new FitParser({ force: true, speedUnit: 'm/s', lengthUnit: 'm' })
    p.parse(buf, (err, data) => {
      if (err) return reject(new Error(err))
      if (!data) return reject(new Error(`FIT 解析失败: ${fileName}`))
      try {
        resolve(recordsToTrack((data.records ?? []) as unknown as FitRecord[], fileName))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}
