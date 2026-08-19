import FitParser from 'fit-file-parser'
import { createTrack, type Track } from '../model/track'

/**
 * We deliberately decouple from fit-file-parser's own `ParsedRecord` type:
 * that package's shipped `.d.ts` declares `timestamp: string`, but at
 * runtime (see its `binary.js`) the field is actually populated with a
 * `Date` object. Rather than depend on that mismatch, we define the minimal
 * shape we consume and cast into it (see `parseFit` below).
 *
 * `cadence`/`power`/`temperature` are confirmed present on the library's own
 * `ParsedRecord` type (`node_modules/fit-file-parser/dist/cjs/fit_types.d.ts`)
 * -- `cadence` (rpm/spm, device-dependent, no unit conversion applied, same
 * "pass through whatever the device reports" policy as `altitude`/
 * `heart_rate`), `power` (watts), `temperature` (°C -- `FitParser`'s
 * `temperatureUnit` option defaults to `'celsius'` and `parseFit` below does
 * not override it, see `dist/cjs/fit-parser.js`).
 */
interface FitRecord {
  position_lat?: number
  position_long?: number
  altitude?: number
  timestamp?: Date
  heart_rate?: number
  cadence?: number
  power?: number
  temperature?: number
}

export function recordsToTrack(records: FitRecord[], fileName: string, creator?: string): Track {
  const lon: number[] = []
  const lat: number[] = []
  const ele: number[] = []
  const time: number[] = []
  const hr: number[] = []
  const cadence: number[] = []
  const power: number[] = []
  const temperature: number[] = []
  let hasEle = false
  let hasTime = false
  let hasHr = false
  let hasCadence = false
  let hasPower = false
  let hasTemperature = false
  for (const r of records) {
    if (typeof r.position_lat !== 'number' || typeof r.position_long !== 'number') continue
    lat.push(r.position_lat)
    lon.push(r.position_long)
    if (typeof r.altitude === 'number') { hasEle = true; ele.push(r.altitude) } else ele.push(NaN)
    if (r.timestamp) { hasTime = true; time.push(r.timestamp.getTime()) } else time.push(NaN)
    if (typeof r.heart_rate === 'number') { hasHr = true; hr.push(r.heart_rate) } else hr.push(0)
    // cadence/power/temperature: 0 是合法真实读数(见 core/model/track.ts 里
    // 这三个字段的注释),逐点缺失一律用 NaN,不能像 hr 那样借用 0 当哨兵。
    if (typeof r.cadence === 'number') { hasCadence = true; cadence.push(r.cadence) } else cadence.push(NaN)
    if (typeof r.power === 'number') { hasPower = true; power.push(r.power) } else power.push(NaN)
    if (typeof r.temperature === 'number') { hasTemperature = true; temperature.push(r.temperature) } else temperature.push(NaN)
  }
  if (lon.length === 0) throw new Error(`FIT 无轨迹点: ${fileName}`)
  return createTrack(
    {
      lon, lat,
      ele: hasEle ? ele : undefined,
      time: hasTime ? time : undefined,
      hr: hasHr ? hr : undefined,
      cadence: hasCadence ? cadence : undefined,
      power: hasPower ? power : undefined,
      temperature: hasTemperature ? temperature : undefined,
    },
    { name: fileName.replace(/\.fit$/i, ''), format: 'fit', fileName, creator },
  )
}

/**
 * FIT has no top-level "creator" the way GPX/KML do -- the closest
 * equivalent is the `file_id` message's `product_name` (e.g. "COROS VERTIX
 * 2S") or, failing that, its `manufacturer` enum (e.g. "coros"). Prefer
 * `product_name`: it's the more informative string and, like GPX's own
 * `creator="COROS Wearables"`, still contains the device-brand substring
 * crs/detect.ts's WGS84_PAT already matches -- so surfacing it through
 * TrackMeta.creator is enough to get real device FIT exports recognised as
 * WGS-84/high-confidence without teaching detectCrs anything FIT-specific.
 */
function creatorFromFileId(fileIds: { manufacturer?: string; product_name?: string }[] | undefined): string | undefined {
  const id = fileIds?.[0]
  return id?.product_name ?? id?.manufacturer
}

export function parseFit(buf: ArrayBuffer, fileName: string): Promise<Track> {
  return new Promise((resolve, reject) => {
    const p = new FitParser({ force: true, speedUnit: 'm/s', lengthUnit: 'm' })
    p.parse(buf, (err, data) => {
      if (err) return reject(new Error(err))
      if (!data) return reject(new Error(`FIT 解析失败: ${fileName}`))
      try {
        const creator = creatorFromFileId(data.file_ids)
        resolve(recordsToTrack((data.records ?? []) as unknown as FitRecord[], fileName, creator))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}
