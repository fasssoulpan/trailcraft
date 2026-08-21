import { newId, type Track } from '../model/track'
import type { CheckPoint, CpKind } from '../model/checkpoint'
import { anchorMonotonic } from '../stats/anchor'
import { nearestVertex } from '../geo/nearestVertex'
import type { ImportedWaypoint } from './import'

/**
 * Best-effort kind inference from a checkpoint's own name. Deliberately
 * shallow -- a real Chinese-name classifier for "gear check" / "danger
 * section" / "cutoff" would need a much larger vocabulary and would still
 * guess wrong often enough to be worse than just asking the user. `补给`
 * ("aid/supply") is the one unambiguous signal worth encoding: race KML
 * checkpoint names almost always spell it out literally when a stop is an
 * aid station. Everything else defaults to the plain `'cp'` kind, which the
 * user can retype from the CP panel same as any manually-added checkpoint.
 */
export function inferCpKind(name: string): CpKind {
  const normalized = name.trim().toLowerCase()
  if (/(补给|供给|aid\b|\bas\d*)/i.test(normalized)) return 'aid'
  // Official race files frequently name a checkpoint after its location
  // (e.g. “CP2 红花梁隧道管理站”). An explicit CP id is the stronger signal;
  // preserve it as a neutral route marker before testing generic place words.
  if (/(^|[\s_-])cp\s*\d*\b|签到|打卡|check.?in/i.test(normalized)) return 'marker'
  if (/(水源|取水|water\b)/i.test(normalized)) return 'water'
  if (/(危险|落石|陡坡|悬崖|danger|hazard)/i.test(normalized)) return 'danger'
  if (/(避难|庇护|shelter)/i.test(normalized)) return 'shelter'
  if (/(岔路|分叉|路口|junction|fork)/i.test(normalized)) return 'junction'
  if (/(营地|露营|camp)/i.test(normalized)) return 'camp'
  if (/(换装|换鞋|更衣|更换装备|change)/i.test(normalized)) return 'change'
  return 'marker'
}

/**
 * Maps a KML's `<Point>` waypoints onto `track` as CheckPoints, anchoring
 * all of them in one `anchorMonotonic` call. This is exactly why
 * `anchorMonotonic` exists in the first place: for an out-and-back or
 * figure-8 course, anchoring each checkpoint independently against
 * "globally nearest track point" would silently collapse an outbound and a
 * return-leg checkpoint at the same physical location onto the same pass.
 *
 * `anchorMonotonic` needs its clicks in course order to do that safely, and
 * a real checkpoint list's document order is normally exactly that -- but
 * not always exactly: the 崇礼 race KML this was built against lists a
 * "起终点" (start-&-finish) checkpoint FIRST, and that checkpoint sits at a
 * near-tie between the track's very first and very last point (this is a
 * closed-loop course -- start and finish are ~9m apart). It happens to be a
 * hair closer to the *finish*. Feeding it into `anchorMonotonic` first would
 * pin the monotonic floor at the very end of the track and force every
 * later checkpoint (12.5km, 24.1km, ...) to also anchor near the end --
 * exactly the corruption this function exists to prevent, just triggered by
 * a checkpoint list that isn't in strict course order rather than by a
 * single ambiguous click.
 *
 * Fixed with a cheap pre-pass: compute each waypoint's independent,
 * unconstrained nearest-vertex index first, then sort by that index before
 * running the monotonic chain. For checkpoints with distinct positions this
 * reproduces document order exactly (their raw nearest-vertex indices are
 * already increasing), so the common case is unaffected. Two waypoints that
 * raw-resolve to the *same* index (the true out-and-back case) tie-break by
 * original relative order (stable sort) and still go through
 * `anchorMonotonic` back-to-back, so that safety property is preserved.
 */
export function checkpointsFromWaypoints(track: Track, waypoints: ImportedWaypoint[]): CheckPoint[] {
  if (waypoints.length === 0) return []
  const { lon, lat } = track.points

  const withRaw = waypoints.map((w, originalIndex) => ({
    w,
    originalIndex,
    raw: nearestVertex(lon, lat, w.lon, w.lat).index,
  })).filter(({ raw }) => raw > 2 && raw < lon.length - 3)
  if (withRaw.length === 0) return []
  withRaw.sort((a, b) => a.raw - b.raw)

  const anchored = anchorMonotonic(lon, lat, withRaw.map(({ w }) => [w.lon, w.lat] as [number, number]))

  return withRaw.map(({ w }, index) => ({
    id: newId('cp'),
    trackId: track.id,
    name: w.name,
    kind: inferCpKind(w.name),
    anchorIndex: anchored[index],
    clickLngLat: [w.lon, w.lat],
  }))
}
