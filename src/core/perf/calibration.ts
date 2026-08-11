/**
 * Calibration reference-point table for the performance-score power-law
 * model (`score.ts`, P2 §3.2/§5). Pure data -- no fitting logic lives here,
 * see `scripts/calibrate-perf.ts` for that (P2 Q2 commit 1). This file
 * exists so the model's calibration is an editable, inspectable table
 * instead of two magic numbers buried in a comment: add a row here (with an
 * honest `confidence`) and re-run the script to see how it moves the fit.
 *
 * ── Honesty requirements (P2 §5) ──────────────────────────────────────────
 * The performance score is a community reverse-engineered estimate, never
 * an official ITRA figure. Several rows below are ESTIMATES, not measured
 * facts -- `confidence` records that distinction and the fitting script
 * weighs rows accordingly. Do not add a row with a fabricated
 * `expectedScore`/course spec to make a fit look better; if a real number
 * isn't available, either omit the row or omit just the field you don't
 * have (most rows below have no `expectedScore` at all -- they exist for
 * the STRUCTURAL checks in `calibrate-perf.ts`, not the numeric fit, because
 * no independently-published PI exists for them to fit against).
 */
import type { PerformanceLevel } from './score'

export type CalibrationConfidence = 'high' | 'medium' | 'low'

export interface CalibrationRow {
  label: string
  distanceKm: number
  ascentM: number
  descentM: number
  hours: number
  /** Known/expected PI for this row -- only set when we have a real,
   * independently-published number to fit against. Most rows below leave
   * this undefined and are used for the structural checks instead (see
   * `calibrate-perf.ts`): "no category winner hits the cap", "category
   * winners of the same race stay in a comparable band", "a short effort
   * doesn't outscore a long elite one". */
  expectedScore?: number
  expectedLevel?: PerformanceLevel
  /** Where this row's numbers come from. */
  source: string
  /** How much the fitting script should trust `expectedScore` when fitting
   * C/K/M. Rows without `expectedScore` aren't part of the numeric fit at
   * all (their confidence only documents how solid distanceKm/ascentM/hours
   * are), but every row participates in the structural checks. */
  confidence: CalibrationConfidence
  /** Caveats worth surfacing next to the row wherever it's reported --
   * which figures are estimated, and how. */
  note?: string
}

// UTMB's official "km-effort" is commonly cited as ~270 (170km + 10000m D+
// / 100, the v1 formula with no descent term) -- a widely-recognised
// "this is what elite ultra scale looks like" reference point, independent
// of any one implementation's kme_v2 variant. Used only as the length-
// normalisation anchor scale (`KME_REF` in score.ts), not as a data row.
export const UTMB_KME_REF_V1 = 270

export const CALIBRATION_TABLE: CalibrationRow[] = [
  // ── The reference's own dual calibration anchors ────────────────────────
  // Both are long-distance/high-pace by construction, which is exactly why
  // the bias this milestone fixes was invisible in the reference's own
  // testing (P2 Q2 brief) -- they're still the only two rows with a
  // genuinely independently-stated `expectedScore`, so they anchor the fit.
  {
    label: 'flat anchor (92km/186m D+, 12.75h)',
    distanceKm: 92,
    ascentM: 186,
    // The reference's header comment doesn't state D- for this anchor.
    // Flat anchors of this kind are typically loop/out-and-back courses
    // with D- close to D+; assuming D- = D+ = 186m here (documented
    // assumption, not a value the reference actually gives us -- see
    // tests/core/score.test.ts's identical assumption for the existing
    // dual-anchor regression tests).
    descentM: 186,
    hours: 12.75,
    expectedScore: 366,
    expectedLevel: '中等',
    source: 'cyber-trail-hud scoring_v4.js header comment (flat anchor)',
    confidence: 'high',
    note: 'descentM assumed equal to ascentM (undocumented in the reference)',
  },
  {
    label: 'UTMB anchor (170km/10000m D+/10000m D-, 20h)',
    distanceKm: 170,
    ascentM: 10000,
    descentM: 10000,
    hours: 20,
    expectedScore: 1000,
    expectedLevel: '精英级',
    source: 'cyber-trail-hud scoring_v4.js header comment (UTMB anchor)',
    confidence: 'high',
  },

  // ── 2026 崇礼168 category winners (real race results the user supplied) ──
  // None of these carry `expectedScore`: there is no independently-published
  // PI for any of them, only their real finish times -- the "Model PI"
  // figures in the P2 Q2 brief are the CURRENT (buggy) model's own output,
  // not a target to fit toward (fitting a model to reproduce its own bug
  // would be circular). They exist for the structural checks instead: no
  // category winner should hit the 1000 cap, and winners of different
  // categories of the same race (comparable-calibre national elites) should
  // land in a reasonable band of each other.
  {
    label: '崇礼168 2026, 168km, 赵家驹 (course record)',
    distanceKm: 172.8,
    ascentM: 7944,
    // The course's own KML (`路线-崇礼_172_8km-7944m20260706090026.kml`)
    // starts and ends within ~2m of the same coordinate (115.2848383,
    // 40.9748450 -> 115.2848624,40.9748571) -- i.e. it's a closed loop, so
    // D- = D+ = 7944m follows from the course closing on itself, not a
    // guess.
    descentM: 7944,
    hours: 19 + 1 / 60 + 32 / 3600,
    source: "race's own KML (distance/ascent exact) + user-supplied result (time)",
    confidence: 'high',
    note: 'distanceKm/ascentM exact from KML; descentM inferred from the course being a closed loop',
  },
  {
    label: '崇礼168 2026, 168km, 陈霖 (women\'s winner)',
    distanceKm: 172.8,
    ascentM: 7944,
    descentM: 7944,
    hours: 22 + 46 / 60 + 17 / 3600,
    source: "race's own KML (distance/ascent exact) + user-supplied result (time)",
    confidence: 'high',
    note: 'distanceKm/ascentM exact from KML; descentM inferred from the course being a closed loop',
  },
  {
    label: '崇礼168 2026, 100km, 管油胜',
    // No course KML for this category. distanceKm is the announced nominal
    // category distance, not a GPS-measured figure. ascentM is a rough
    // proportional estimate from the 168km course's own measured gain rate
    // (7944m / 172.8km ~= 45.97 m/km) -- real short-category courses on the
    // same race often share climbs with the long course, but can also cut
    // flatter connector sections, so this is a rough estimate, not a fact.
    distanceKm: 100,
    ascentM: 4597,
    descentM: 4597,
    hours: 10 + 28 / 60 + 4 / 3600,
    source: 'user-supplied result (time, real); distance/ascent estimated (see note)',
    confidence: 'low',
    note: 'distanceKm is the nominal category distance (not GPS-measured); ascentM is proportional to the 168km course\'s measured gain rate, not sourced',
  },
  {
    label: '崇礼168 2026, 70km, 张火话',
    distanceKm: 70,
    ascentM: 3218,
    descentM: 3218,
    hours: 4 + 31 / 60 + 30 / 3600,
    source: 'user-supplied result (time, real); distance/ascent estimated (see note)',
    confidence: 'low',
    note: 'distanceKm is the nominal category distance (not GPS-measured); ascentM is proportional to the 168km course\'s measured gain rate, not sourced',
  },
  {
    label: '崇礼168 2026, 50km, 杨春龙',
    distanceKm: 50,
    ascentM: 2299,
    descentM: 2299,
    hours: 4 + 24 / 60 + 47 / 3600,
    source: 'user-supplied result (time, real); distance/ascent estimated (see note)',
    confidence: 'low',
    note: 'distanceKm is the nominal category distance (not GPS-measured); ascentM is proportional to the 168km course\'s measured gain rate, not sourced',
  },

  // ── Room for the user to add rows later ──────────────────────────────────
  // This table is the point: add a row (real distance/ascent/hours, and
  // `expectedScore` only if you have a real published number, otherwise
  // leave it off and it still participates in the structural checks) and
  // re-run `npx vite-node scripts/calibrate-perf.ts` to see how it moves
  // the fit.
]
