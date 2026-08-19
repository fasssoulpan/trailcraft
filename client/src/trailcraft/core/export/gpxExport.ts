/**
 * Track -> GPX 1.1 文本导出。
 *
 * targetCrs 存在的原因:国内 App(高德/腾讯系)默认认 GCJ-02,而 GPS 设备
 * 和 OSM 生态默认认 WGS-84——两者用错了坐标系,轨迹在地图上会整体偏移
 * 数百米。TrailCraft 内部永远以 WGS-84 存储(见 core/model/track.ts),导出
 * 时按用户选择的目标坐标系做一次性转换,而不是让用户在导入/导出两端各自
 * 记一次"这份数据到底是哪个坐标系"。
 *
 * 输出顺序刻意把 `<trk>` 放在 `<wpt>` 之前(GPX 1.1 XSD 的推荐顺序其实是反过来
 * 的:wpt* 在 trk* 之前)。这是因为本项目自己的 parseGpx(core/parsers/gpx.ts)
 * 用一个简单的"文档中第一个 <name> 标签"正则来判定轨迹名——如果 <wpt>(每个
 * CP 都带 <name>)排在 <trk> 前面,重新导入自己导出的文件时,轨迹名会被
 * 误判成第一个 CP 的名字。绝大多数消费者对元素顺序并不严格校验 XSD,这个
 * 权衡换来的是"自己导出的文件能被自己正确读回"。
 */
import type { Track, Crs } from '../model/track'
import type { CheckPoint } from '../model/checkpoint'
import { convertTrackArrays } from '../crs/transform'

/** Chinese 轨迹/CP 名称里出现 & 或 < 都很常见,不转义会产出非法 XML。 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function convertPoint(lon: number, lat: number, targetCrs: Crs): [number, number] {
  if (targetCrs === 'wgs84') return [lon, lat]
  const r = convertTrackArrays(Float64Array.from([lon]), Float64Array.from([lat]), 'wgs84', targetCrs)
  return [r.lon[0], r.lat[0]]
}

export function trackToGpx(track: Track, cps: CheckPoint[], targetCrs: Crs): string {
  const { points } = track
  const converted = targetCrs === 'wgs84' ? undefined : convertTrackArrays(points.lon, points.lat, 'wgs84', targetCrs)
  const lon = converted?.lon ?? points.lon
  const lat = converted?.lat ?? points.lat
  const n = lon.length

  const trkptXml: string[] = []
  for (let i = 0; i < n; i++) {
    let inner = ''
    if (points.ele && !Number.isNaN(points.ele[i])) inner += `<ele>${points.ele[i]}</ele>`
    if (points.time && !Number.isNaN(points.time[i])) inner += `<time>${new Date(points.time[i]).toISOString()}</time>`
    trkptXml.push(`   <trkpt lat="${lat[i]}" lon="${lon[i]}">${inner}</trkpt>`)
  }

  const wptXml = cps.map((cp) => {
    const n2 = points.lon.length
    const fallbackIdx = Math.min(Math.max(cp.anchorIndex, 0), n2 - 1)
    const rawLon = cp.clickLngLat ? cp.clickLngLat[0] : points.lon[fallbackIdx]
    const rawLat = cp.clickLngLat ? cp.clickLngLat[1] : points.lat[fallbackIdx]
    const [wlon, wlat] = convertPoint(rawLon, rawLat, targetCrs)
    return ` <wpt lat="${wlat}" lon="${wlon}"><name>${escapeXml(cp.name)}</name></wpt>`
  })

  const trkName = escapeXml(track.meta.name)

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="TrailCraft" version="1.1">
 <trk>
  <name>${trkName}</name>
  <trkseg>
${trkptXml.join('\n')}
  </trkseg>
 </trk>
${wptXml.join('\n')}
</gpx>
`
}
