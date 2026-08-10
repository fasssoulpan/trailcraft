/**
 * Renders `CheckPoint`s belonging to the currently-displayed track into a
 * Cesium `Viewer`'s entity collection (P1 §3.1, milestone N2 commit 3).
 *
 * Mirrors `src/map/trackLayer.ts`'s `syncCpMarkers` contract, with one
 * deliberate difference: `syncCpMarkers` trusts its caller (`MapView.tsx`)
 * to have already filtered `cps` down to the active track before calling
 * it. That's exactly the shape of bug P0 fixed once already (checkpoints
 * leaking across tracks because some caller forgot to filter) -- this
 * module does the `CheckPoint.trackId` filtering itself instead of trusting
 * the caller, so it cannot reintroduce that bug even if a future caller
 * forgets.
 *
 * Not unit-tested, same as trackEntities.ts and for the same reason: no
 * WebGL in Node. All the logic here is thin enough (filter + position
 * lookup + entity CRUD) that there's nothing worth extracting into a pure
 * module the way trackGeometry.ts exists for track rendering.
 */
import { Cartesian2, Cartesian3, Color, ConstantPositionProperty, ConstantProperty, HeightReference, LabelStyle, NearFarScalar, VerticalOrigin, type Entity, type Viewer } from 'cesium'
import type { CheckPoint } from '../core/model/checkpoint'
import type { Track } from '../core/model/track'
import { CP_KIND_COLORS } from '../map/trackLayer'

interface CpEntityInfo {
  /** Last-rendered CheckPoint snapshot, so we can tell whether an in-place
   * update is even needed (position/kind/name/ordinal all read from this
   * vs. the incoming cp). */
  cp: CheckPoint
  ordinal: number
  /** The Track object `cp`'s position was last resolved against. Track is
   * immutable (see core/model/track.ts), so a reference change means the
   * coordinates at the *same* anchorIndex may now point somewhere else
   * entirely (e.g. after a reverse/simplify toolbox op) -- this alone must
   * force a position update even when nothing on the CheckPoint itself
   * changed. */
  track: Track
  entity: Entity
}

const knownCpEntities = new WeakMap<Viewer, Map<string, CpEntityInfo>>()

function cpEntityId(cpId: string): string {
  return `cp-${cpId}`
}

/**
 * `cp.anchorIndex` into `track.points`, read directly (full precision) --
 * simpler and exact compared to inverting trackGeometry.ts's decimated
 * `idx` mapping, and correct because `anchorIndex` is always a full-
 * precision index by construction (see core/model/checkpoint.ts).
 *
 * Height reference is CLAMP_TO_GROUND (matching the start/finish markers in
 * trackEntities.ts), so unlike trackGeometry.ts's height fallback for the
 * polyline/timeline, the actual elevation value passed to
 * `Cartesian3.fromDegrees` here is irrelevant -- Cesium overrides it with
 * the terrain height at render time regardless of what's passed in.
 */
function resolvePosition(track: Track, cp: CheckPoint): Cartesian3 | undefined {
  const { lon, lat } = track.points
  if (cp.anchorIndex < 0 || cp.anchorIndex >= lon.length) return undefined
  return Cartesian3.fromDegrees(lon[cp.anchorIndex], lat[cp.anchorIndex], 0)
}

function labelText(cp: CheckPoint, ordinal: number): string {
  return `${ordinal}. ${cp.name}`
}

/**
 * Builds a coloured point + ordinal/name label. Labels use
 * FILL_AND_OUTLINE with a black outline and `disableDepthTestDistance`
 * (matching trackEntities.ts's start/finish markers) so they stay legible
 * over the satellite imagery this scene renders against -- the 2D CP
 * markers (trackLayer.ts's `styleCpMarkerElement`) only need a solid
 * background circle because they sit on the light OSM basemap, not
 * imagery, so that approach alone wouldn't read here.
 */
function buildCpEntity(id: string, position: Cartesian3, color: string, text: string): Entity.ConstructorOptions {
  return {
    id,
    position,
    point: {
      pixelSize: 11,
      color: Color.fromCssColorString(color),
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      scaleByDistance: new NearFarScalar(300, 1.0, 30_000, 0.4),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text,
      font: '13px sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -14),
      scaleByDistance: new NearFarScalar(300, 1.0, 30_000, 0.3),
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }
}

function needsUpdate(prev: CpEntityInfo, cp: CheckPoint, ordinal: number, track: Track): boolean {
  return (
    prev.track !== track ||
    prev.cp.anchorIndex !== cp.anchorIndex ||
    prev.cp.kind !== cp.kind ||
    prev.cp.name !== cp.name ||
    prev.ordinal !== ordinal
  )
}

function applyCpUpdate(entity: Entity, position: Cartesian3, color: string, text: string): void {
  entity.position = new ConstantPositionProperty(position)
  if (entity.point) entity.point.color = new ConstantProperty(Color.fromCssColorString(color))
  if (entity.label) entity.label.text = new ConstantProperty(text)
}

/**
 * Adds/updates/removes one point+label entity per checkpoint belonging to
 * `activeTrackId`, mirroring `trackLayer.ts`'s `syncCpMarkers` contract.
 *
 * `cps` is the *full*, unfiltered store list (unlike `syncCpMarkers`, which
 * expects the caller to have pre-filtered -- see this module's file-level
 * comment for why the filtering happens here instead). Checkpoints
 * belonging to any track other than `activeTrackId` -- or all of them, if
 * there is no active track -- are simply not rendered.
 *
 * Positioned via `anchorIndex` read directly against `activeTrackId`'s
 * `Track` in `tracks`; a checkpoint whose `anchorIndex` is out of range for
 * that track (e.g. mid-way through a toolbox op that hasn't finished
 * re-anchoring yet) is skipped for this sync rather than crashing.
 */
export function syncCpEntities(viewer: Viewer, cps: CheckPoint[], tracks: Track[], activeTrackId?: string): void {
  let known = knownCpEntities.get(viewer)
  if (!known) {
    known = new Map()
    knownCpEntities.set(viewer, known)
  }

  const track = tracks.find((t) => t.id === activeTrackId)
  const scoped = track ? cps.filter((c) => c.trackId === track.id) : []

  const currentIds = new Set(scoped.map((c) => c.id))
  for (const [id, info] of known) {
    if (currentIds.has(id)) continue
    viewer.entities.remove(info.entity)
    known.delete(id)
  }

  scoped.forEach((cp, i) => {
    if (!track) return // unreachable (scoped is empty when track is undefined), kept for type narrowing
    const position = resolvePosition(track, cp)
    if (!position) return

    const ordinal = i + 1
    const color = CP_KIND_COLORS[cp.kind]
    const text = labelText(cp, ordinal)

    const existing = known!.get(cp.id)
    if (!existing) {
      const entity = viewer.entities.add(buildCpEntity(cpEntityId(cp.id), position, color, text))
      known!.set(cp.id, { cp, ordinal, track, entity })
      return
    }
    if (needsUpdate(existing, cp, ordinal, track)) {
      applyCpUpdate(existing.entity, position, color, text)
    }
    existing.cp = cp
    existing.ordinal = ordinal
    existing.track = track
  })
}
