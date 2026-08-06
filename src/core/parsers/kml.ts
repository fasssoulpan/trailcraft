import { createTrack, type Track } from '../model/track'

/**
 * Regex-based KML parser. Handles two shapes seen in the wild:
 *  - `gx:Track` (Google's KML extension): parallel `<gx:coord>`/`<when>`
 *    sequences, one coord per timestamp. Preferred when present because it
 *    carries time.
 *  - Plain `<Placemark><LineString><coordinates>`: one or more blocks of
 *    whitespace-separated `lon,lat[,ele]` tuples, concatenated in document
 *    order. No time information.
 * No coordinate-system transform happens here — points are handed back
 * exactly as read (GCJ-02 detection/conversion is a later task).
 */
export function parseKml(xml: string, fileName: string): Track {
  const name = /<name>([^<]*)<\/name>/.exec(xml)?.[1]?.trim()
  const lon: number[] = []
  const lat: number[] = []
  const ele: number[] = []
  const time: number[] = []
  let hasEle = false
  let hasTime = false

  // gx:Track 优先(带时间)
  const coords = [...xml.matchAll(/<gx:coord>([^<]+)<\/gx:coord>/g)]
  if (coords.length > 0) {
    const whens = [...xml.matchAll(/<when>([^<]+)<\/when>/g)]
    coords.forEach((c, i) => {
      const [x, y, z] = c[1].trim().split(/\s+/).map(Number)
      lon.push(x)
      lat.push(y)
      if (Number.isFinite(z)) { hasEle = true; ele.push(z) } else ele.push(NaN)
      const w = whens[i]?.[1]
      if (w) { hasTime = true; time.push(Date.parse(w)) } else time.push(NaN)
    })
  } else {
    // 所有 LineString 的 coordinates 顺序拼接
    for (const m of xml.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)) {
      for (const tuple of m[1].trim().split(/\s+/)) {
        if (!tuple) continue
        const parts = tuple.split(',').map(Number)
        if (parts.length < 2 || !Number.isFinite(parts[0])) continue
        lon.push(parts[0])
        lat.push(parts[1])
        if (parts.length >= 3 && Number.isFinite(parts[2])) { hasEle = true; ele.push(parts[2]) } else ele.push(NaN)
        time.push(NaN)
      }
    }
  }

  if (lon.length === 0) throw new Error(`KML 无轨迹点: ${fileName}`)

  return createTrack(
    {
      lon,
      lat,
      ele: hasEle ? ele : undefined,
      time: hasTime ? time : undefined,
    },
    { name: name ?? fileName, format: 'kml', fileName },
  )
}
