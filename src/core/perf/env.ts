/**
 * Environmental compensation coefficient, ported from
 * `cyber-trail-hud/src/analysis/env-compensation.js` (P2 §3.2, milestone
 * Q2). User's own project, no licence obstacle.
 *
 * Two independent multiplicative factors, applied to the performance score
 * in `score.ts`:
 * 1. Heat compensation: above 16°C, capability drops ~0.4% per additional
 *    degree (plus a humidity penalty above 60%), capped at +10%.
 * 2. Altitude compensation: above 300m mean altitude, VO2max drops with
 *    elevation (7-14.5% per 1000m in the literature the reference cites);
 *    modelled here as a capped multiplicative penalty.
 *
 * `temperature`/`humidity` have no automated source yet (no weather API
 * integration in TrailCraft) -- passing neither leaves `heatFactor` neutral
 * at 1.0, exactly like the reference's "reserved interface" comment
 * describes. Altitude compensation is always computed from the track's own
 * elevation column, so it's live from day one.
 *
 * Porting notes: numerically identical to the reference. Adapted for the
 * columnar model: the reference's `elePoints` filter/weighted-average loop
 * over point objects becomes a loop over `track.points.ele`/`dist` directly.
 */
import type { Track } from '../model/track'
import { computeCumDist } from '../geo/distance'

export interface EnvUserProfile {
  /** Ambient temperature in °C. */
  temperature?: number
  /** Relative humidity in %. */
  humidity?: number
}

export interface EnvCompensation {
  heatFactor: number
  altFactor: number
  /** `heatFactor * altFactor`, rounded -- the single multiplier `score.ts`
   * applies to the power-law speed term. */
  totalFactor: number
}

const HEAT_FACTOR_CAP = 1.1
const ALT_COMPENSATION_START_M = 300
const ALT_K = 0.075
const ALT_FACTOR_FLOOR_DENOM = 0.7

export function computeEnvCompensation(track: Track, profile: EnvUserProfile = {}): EnvCompensation {
  let heatFactor = 1.0
  let altFactor = 1.0

  // ---- Heat compensation ----
  const { temperature, humidity } = profile
  if (temperature != null && temperature > 16) {
    const tempPenalty = (temperature - 16) * 0.004
    const humPenalty = humidity != null && humidity > 60 ? (humidity - 60) * 0.002 : 0
    heatFactor = Math.min(1 + tempPenalty + humPenalty, HEAT_FACTOR_CAP)
  }

  // ---- Altitude compensation ----
  const { ele } = track.points
  const dist = track.points.cumDist ?? computeCumDist(track.points.lon, track.points.lat)
  if (ele) {
    const n = ele.length
    // Distance-weighted mean altitude over points with a positive elevation
    // reading -- matches the reference's `p.ele !== null && p.ele > 0` filter.
    let firstIdx = -1
    let lastIdx = -1
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(ele[i]) && ele[i] > 0) {
        if (firstIdx === -1) firstIdx = i
        lastIdx = i
      }
    }
    if (firstIdx !== -1) {
      const totalDist = dist[lastIdx] - dist[firstIdx]
      if (totalDist > 0) {
        let weightedEle = 0
        let prevIdx = firstIdx
        for (let i = firstIdx + 1; i <= lastIdx; i++) {
          if (!Number.isFinite(ele[i]) || ele[i] <= 0) continue
          const segDist = dist[i] - dist[prevIdx]
          weightedEle += ele[i] * segDist
          prevIdx = i
        }
        const avgAlt = weightedEle / totalDist
        if (avgAlt > ALT_COMPENSATION_START_M) {
          const decay = (ALT_K * (avgAlt - ALT_COMPENSATION_START_M)) / 1000
          altFactor = 1 / Math.max(1 - decay, ALT_FACTOR_FLOOR_DENOM)
        }
      }
    }
  }

  return {
    heatFactor: Math.round(heatFactor * 1000) / 1000,
    altFactor: Math.round(altFactor * 1000) / 1000,
    totalFactor: Math.round(heatFactor * altFactor * 1000) / 1000,
  }
}
