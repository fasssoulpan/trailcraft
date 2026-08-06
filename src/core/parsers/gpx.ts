import { createTrack, type Track } from '../model/track'

// Numeric literal shared by ele/lat/lon: optional sign, digits with optional
// decimal point, and an optional scientific-notation exponent (e.g. "1.5e3",
// "-2.5E-1"). Without the exponent part, a value like "1.5e3" fails to match
// entirely (the literal "e3" breaks the immediately-following closing tag /
// attribute-quote match), which silently drops the whole column instead of
// just the one point.
const NUM = String.raw`-?[\d.]+(?:[eE][-+]?\d+)?`
const ELE_RE = new RegExp(`<ele>(${NUM})<\\/ele>`)
const TIME_RE = /<time>([^<]+)<\/time>/
const HR_RE = /<(?:\w+:)?hr>(\d+)<\/(?:\w+:)?hr>/
const LAT_RE = new RegExp(`\\blat="(${NUM})"`)
const LON_RE = new RegExp(`\\blon="(${NUM})"`)

// Single-pass regex over the whole document: matches either a self-closing
// `<trkpt .../>` (group 1 = attrs, no body) or a paired `<trkpt ...>...</trkpt>`
// (group 2 = attrs, group 3 = body). This avoids a second full scan of the
// string just to catch the rare self-closing form.
const TRKPT_RE = /<trkpt\b([^>]*?)\/>|<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g

/**
 * Regex-based GPX parser (fast path). Deliberately avoids building a DOM/XML
 * tree: real COROS export files reach ~105 MB / 330k points, and a full-tree
 * parse of that would blow memory / be far too slow for the <2s @ 1万点
 * acceptance target. All real files use the paired `<trkpt ...>...</trkpt>`
 * form with a single <trk>/<trkseg>; multi-segment and self-closing support
 * here exist for robustness against other GPX producers.
 */
export function parseGpx(xml: string, fileName: string): Track {
  const head = xml.slice(0, 4096)
  const creator = /creator="([^"]*)"/.exec(head)?.[1]
  const name = /<name>([^<]*)<\/name>/.exec(xml.slice(0, 65536))?.[1]?.trim()

  const lon: number[] = []
  const lat: number[] = []
  const ele: number[] = []
  const time: number[] = []
  const hr: number[] = []
  let hasEle = false
  let hasTime = false
  let hasHr = false

  let m: RegExpExecArray | null
  while ((m = TRKPT_RE.exec(xml))) {
    let attrs: string
    let body: string | undefined
    if (m[1] !== undefined) {
      // self-closing <trkpt lat=".." lon=".."/>
      attrs = m[1]
      body = undefined
    } else {
      attrs = m[2]
      body = m[3]
    }

    const la = LAT_RE.exec(attrs)
    const lo = LON_RE.exec(attrs)
    if (!la || !lo) continue
    lat.push(+la[1])
    lon.push(+lo[1])

    if (body !== undefined) {
      const e = ELE_RE.exec(body)
      if (e) { hasEle = true; ele.push(+e[1]) } else ele.push(NaN)
      const t = TIME_RE.exec(body)
      if (t) { hasTime = true; time.push(Date.parse(t[1])) } else time.push(NaN)
      const h = HR_RE.exec(body)
      if (h) { hasHr = true; hr.push(+h[1]) } else hr.push(0)
    } else {
      ele.push(NaN)
      time.push(NaN)
      hr.push(0)
    }
  }

  if (lon.length === 0) throw new Error(`GPX 无轨迹点: ${fileName}`)

  return createTrack(
    {
      lon,
      lat,
      ele: hasEle ? ele : undefined,
      time: hasTime ? time : undefined,
      hr: hasHr ? hr : undefined,
    },
    { name: name ?? fileName, format: 'gpx', fileName, creator },
  )
}
