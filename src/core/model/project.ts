/**
 * 工程的序列化格式:一个自描述的 GeoJSON FeatureCollection。
 *
 * 选 GeoJSON 而不是自定义 JSON 结构,是为了让工程文件本身也能被其它 GIS
 * 工具(QGIS、geojson.io 等)直接打开检查——每条轨迹是一个 LineString
 * Feature,每个 CP 是一个 Point Feature,几何字段是"通用"的,TrailCraft
 * 私有的东西(TypedArray 拆出来的 ele/time/hr 数组、原始坐标系、配速参数
 * 等)全部塞进 properties,不破坏 GeoJSON 的通用性。
 *
 * `schema_version` 从第一个版本就写进文件,是为了给未来的格式迁移留出
 * 余地——没有它,以后想在读取时区分"旧格式 v0 文件"和"新格式 v1 文件"
 * 就无从下手。
 */
import { createTrack, type Crs, type Track, type TrackMeta } from './track'
import type { CheckPoint, CpKind } from './checkpoint'
import type { PaceParams } from '../pace/models'
import type { StatsOptions } from '../stats/segments'
import { computeCumDist } from '../geo/distance'

export interface ProjectFile {
  schema_version: '1.0'
  type: 'FeatureCollection'
  properties: {
    name: string
    createdAt: string // ISO 8601 含时区
    raceStartTime?: string
    paceParams: PaceParams
    statsOptions: StatsOptions
  }
  features: object[]
}

interface TrackFeatureProperties {
  kind: 'track'
  id: string
  meta: TrackMeta
  originalCrs: Crs
  ele?: number[]
  time?: number[]
  hr?: number[]
}

interface CpFeatureProperties {
  kind: 'cp'
  id: string
  name: string
  cpKind: CpKind
  anchorIndex: number
  clickLngLat?: [number, number]
  cutoffTime?: string
  photoUrl?: string
}

function trackToFeature(t: Track): object {
  const { lon, lat, ele, time, hr } = t.points
  const n = lon.length
  const coordinates: [number, number][] = new Array(n)
  for (let i = 0; i < n; i++) coordinates[i] = [lon[i], lat[i]]
  const properties: TrackFeatureProperties = {
    kind: 'track',
    id: t.id,
    meta: t.meta,
    originalCrs: t.originalCrs,
    // Array.from(undefined) throws, so each column is only emitted when the
    // track actually carries it -- a track lacking elevation must round-trip
    // with ele still `undefined`, not resurrected as an all-NaN column.
    ele: ele ? Array.from(ele) : undefined,
    time: time ? Array.from(time) : undefined,
    hr: hr ? Array.from(hr) : undefined,
  }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties }
}

function cpToFeature(cp: CheckPoint): object {
  // Point 的 geometry 坐标只是给外部 GIS 工具看的"大致位置"(取点击原始
  // 位置,缺失时退化到 [0,0]);真正精确往返的坐标存在 properties.clickLngLat
  // 里,和 CheckPoint 里的字段一一对应,反序列化时直接从 properties 读回,
  // 不依赖 geometry —— 这样 clickLngLat 缺失(理论上不会出现,但类型上允许)
  // 这个状态本身也能被精确保留,不会被"退化坐标"污染成看似存在的值。
  const geometryCoords: [number, number] = cp.clickLngLat ?? [0, 0]
  const properties: CpFeatureProperties = {
    kind: 'cp',
    id: cp.id,
    name: cp.name,
    cpKind: cp.kind,
    anchorIndex: cp.anchorIndex,
    clickLngLat: cp.clickLngLat,
    cutoffTime: cp.cutoffTime,
    photoUrl: cp.photoUrl,
  }
  return { type: 'Feature', geometry: { type: 'Point', coordinates: geometryCoords }, properties }
}

export function serializeProject(
  name: string,
  tracks: Track[],
  cps: CheckPoint[],
  paceParams: PaceParams,
  statsOptions: StatsOptions,
  raceStartTime?: string,
): ProjectFile {
  return {
    schema_version: '1.0',
    type: 'FeatureCollection',
    properties: {
      name,
      createdAt: new Date().toISOString(),
      raceStartTime,
      paceParams,
      statsOptions,
    },
    features: [...tracks.map(trackToFeature), ...cps.map(cpToFeature)],
  }
}

interface RawFeature {
  type: 'Feature'
  geometry: { type: string; coordinates: unknown }
  properties: Record<string, unknown>
}

function featureToTrack(f: RawFeature): Track {
  const coords = f.geometry.coordinates as [number, number][]
  const n = coords.length
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = coords[i][0]
    lat[i] = coords[i][1]
  }
  const p = f.properties as unknown as TrackFeatureProperties
  const track = createTrack(
    { lon, lat, ele: p.ele, time: p.time, hr: p.hr },
    p.meta,
    p.originalCrs,
  )
  // createTrack 生成的是新 id;工程文件里已经保存了稳定的原始 id,读回来
  // 时应当保持一致(否则每次打开同一个工程,所有轨迹的 id 都会变,依赖 id
  // 做等值比较的地方——比如 activeTrackId——全部失效)。
  return { ...track, id: p.id, points: { ...track.points, cumDist: computeCumDist(lon, lat) } }
}

function featureToCp(f: RawFeature): CheckPoint {
  const p = f.properties as unknown as CpFeatureProperties
  return {
    id: p.id,
    name: p.name,
    kind: p.cpKind,
    anchorIndex: p.anchorIndex,
    clickLngLat: p.clickLngLat,
    cutoffTime: p.cutoffTime,
    photoUrl: p.photoUrl,
  }
}

export function deserializeProject(p: ProjectFile): {
  tracks: Track[]
  cps: CheckPoint[]
  paceParams: PaceParams
  statsOptions: StatsOptions
  raceStartTime?: string
} {
  const tracks: Track[] = []
  const cps: CheckPoint[] = []
  for (const raw of p.features as RawFeature[]) {
    if (raw.geometry?.type === 'LineString') tracks.push(featureToTrack(raw))
    else if (raw.geometry?.type === 'Point') cps.push(featureToCp(raw))
  }
  return {
    tracks,
    cps,
    paceParams: p.properties.paceParams,
    statsOptions: p.properties.statsOptions,
    raceStartTime: p.properties.raceStartTime,
  }
}

