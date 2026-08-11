import { createTrack, type Track } from '../model/track'

/**
 * Real COROS KML exports (see `tests/core/kml.test.ts` real-data block) wrap
 * the whole document in a `<Folder>` and put one `<Placemark><LineString>`
 * (the track) alongside a dozen-plus `<Placemark><Point>` siblings (named
 * race checkpoints, plus `Start`/`End` markers in a separate `Laps` folder).
 * A naive document-global `<coordinates>` regex can't tell those apart and
 * appends every `<Point>` as a stray jump on the polyline -- on a real
 * 172.8km race file that inflated total distance by 44%. Coordinates are
 * therefore only ever pulled from *line* geometry:
 *  - `gx:Track` (Google's KML extension): parallel `<gx:coord>`/`<when>`
 *    sequences, one coord per timestamp. Preferred when present because it
 *    carries time. `<gx:coord>` only ever appears inside `<gx:Track>`, so
 *    this branch was already implicitly scoped correctly.
 *  - `<LineString><coordinates>`: one or more blocks, concatenated in
 *    document order. No time information.
 * `<LinearRing>` (polygon boundary) is deliberately NOT treated as line
 * geometry -- it represents an area outline, not a race path, and none of
 * the real-world exports this parser targets ever produce one for a track.
 *
 * Scoping is done by matching the geometry element itself
 * (`<LineString>...</LineString>`) rather than by first splitting the
 * document into `<Placemark>` blocks: `<Placemark>` can sit at arbitrary
 * `<Folder>`/`<Document>` nesting depth and a Placemark can in principle wrap
 * a `<MultiGeometry>` mixing line and point children, so "which coordinates
 * belong to a line" is a property of the geometry tag, not of its ancestor
 * chain. `<LineString>` elements themselves are never nested inside one
 * another, so a single non-greedy document-wide regex correctly captures
 * each one regardless of how deep it sits.
 *
 * Still deliberately regex-based rather than DOM/tree-based: real GPX inputs
 * this codebase handles reach ~105 MB, and even these smaller (0.7-1.1 MB,
 * tens of thousands of points) KML files should stay on the fast path.
 * No coordinate-system transform happens here — points are handed back
 * exactly as read (GCJ-02 detection/conversion happens in the import
 * pipeline).
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
    // 所有 <LineString> 的 coordinates 顺序拼接 —— 每个 LineString 单独抓取
    // 自己的 <coordinates>,而不是对整份文档做一次全局 <coordinates> 匹配,
    // 这样 <Point> placemark(比如赛道 CP 标记)的坐标永远不会混进来。
    for (const ls of xml.matchAll(/<LineString\b[^>]*>([\s\S]*?)<\/LineString>/g)) {
      const coordsMatch = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(ls[1])
      if (!coordsMatch) continue
      for (const tuple of coordsMatch[1].trim().split(/\s+/)) {
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
