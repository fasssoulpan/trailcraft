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
 *
 * ── P2 Q2 commit 5: unverifiable rows must not bind the fit ────────────────
 * `confidence: 'low'` alone used to still leave a row in every structural
 * gate (cap-avoidance, category spread) -- fine for a row that's merely
 * lower-precision (e.g. OCC's alternate-course caveat), but not fine for a
 * row whose course spec is an outright GUESS. Commit 4 found exactly that:
 * 崇礼168 70km's proportionally-estimated ascent (never measured, never
 * sourced) implied a pace mathematically incompatible with staying under
 * 2025 UTMB men for any Riegel-plausible M/K, which dragged the whole safety
 * ceiling down from ~960 to ~808 -- a guessed number was binding the model.
 * `excludeFromFit: true` marks a row as excluded from BOTH the numeric fit
 * (rows without `expectedScore` never were in it) AND every structural
 * constraint in `calibrate-perf.ts` (cap-safety margin, category-spread
 * check) -- the row stays in this table purely for documentation/provenance,
 * never as something the model is required to respect. See the 100km/70km/
 * 50km rows below for the three rows this applies to, and each row's note
 * for why.
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
  /** When true, this row is excluded from BOTH the numeric fit AND every
   * structural constraint in `calibrate-perf.ts` (cap-safety margin,
   * category-spread check) -- it is kept in this table purely for
   * documentation/provenance (P2 Q2 commit 5). Use this for a row whose
   * course spec/time isn't just lower-precision but is actually
   * unverifiable (a guessed distance/ascent, a physically-implausible
   * implied pace) -- `confidence: 'low'` alone still participates in every
   * structural gate, which is correct for a row that's merely uncertain but
   * wrong for a row that's a guess a bad fit could get bound to. */
  excludeFromFit?: boolean
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
  // the bias the P2 Q2 commit-2 milestone fixed was invisible in the
  // reference's own testing. As of P2 Q2 commit 3 (this refit), only the
  // FLAT anchor still carries `expectedScore` -- the mountain anchor's
  // stated 1000 target was removed (see its own note below): with the
  // ceiling now required to stay unreachable by any real winner, forcing an
  // exact-1000 numeric target would fight the fix this commit makes. The
  // flat anchor alone can't determine both C and K, so this refit's `fit`
  // mode (calibrate-perf.ts) solves C exactly from this one real anchor for
  // each candidate (K, M) and picks (K, M) by a 2-D structural-penalty
  // search instead of the old 2-anchor exact solve -- see that file's
  // header for the method.
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
    // P2 Q2 commit 3 (this refit): `expectedScore` REMOVED. The reference's
    // header comment states this synthetic anchor should score exactly
    // 1000, but that is precisely the design intent this refit corrects --
    // real 2025 UTMB winner data (174km/10000m D+, 19:18:58 -- see the
    // international rows below) describes almost exactly this same effort
    // and, per the user's explicit instruction (「到不了1000 极端情况不考虑」),
    // must NOT hit the cap. Treating "exactly 1000" as a hard numeric fit
    // target would reproduce the very over-easy ceiling this milestone
    // fixes, so this row is kept for provenance (it's still real,
    // independently-stated reference data) and the structural cap-avoidance
    // check, but is no longer a numeric-fit anchor.
    label: 'UTMB anchor (170km/10000m D+/10000m D-, 20h) -- reference states 1000, superseded (see note)',
    distanceKm: 170,
    ascentM: 10000,
    descentM: 10000,
    hours: 20,
    source: 'cyber-trail-hud scoring_v4.js header comment (UTMB anchor)',
    confidence: 'high',
    note: 'reference states expectedScore=1000; no longer used as a numeric fit target because the ceiling must stay unreachable (P2 Q2 commit 3) -- structural check only',
  },

  // ── 2026 崇礼168 category winners (real race results the user supplied) ──
  // None of these carry `expectedScore`: there is no independently-published
  // PI for any of them, only their real finish times -- the "Model PI"
  // figures in the P2 Q2 brief are the CURRENT (buggy) model's own output,
  // not a target to fit toward (fitting a model to reproduce its own bug
  // would be circular). The 168km rows (real KML-exact course spec) exist
  // for the structural checks: no category winner should hit the 1000 cap,
  // and the two 168km finishers (same course, same climbing) should land in
  // a reasonable band of each other.
  //
  // The 100km/70km/50km rows below are marked `excludeFromFit: true` (P2 Q2
  // commit 5): their distance/ascent are not race-measured, only a
  // proportional GUESS from the 168km course's gain rate, and for the 70km
  // row that guess implies a physically-implausible pace (see its note) --
  // see this file's header for why a guess must not be allowed to bind any
  // part of the model, numeric or structural. Kept here only for
  // provenance/documentation.
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
    excludeFromFit: true,
    note: 'UNVERIFIABLE, excluded from fit (P2 Q2 commit 5): distanceKm is the nominal category distance (not GPS-measured); ascentM is proportional to the 168km course\'s measured gain rate, not sourced. Kept for provenance only -- do not re-add to the fit without a real course spec.',
  },
  {
    label: '崇礼168 2026, 70km, 张火话',
    distanceKm: 70,
    ascentM: 3218,
    descentM: 3218,
    hours: 4 + 31 / 60 + 30 / 3600,
    source: 'user-supplied result (time, real); distance/ascent estimated (see note)',
    confidence: 'low',
    excludeFromFit: true,
    // REJECTED (P2 Q2 commit 5), not just low-confidence: 70km in 4:31:30 is
    // 15.5 km/h average -- over a 70km mountain course with an estimated
    // 3000m+ of climbing, that is faster than either 2025 UTMB men's winner
    // (9.0 km/h, 174km/10000m D+) or 2025 OCC's winner (11.4 km/h, 57km/
    // 3500m D+) on genuinely comparable terrain. Not physically credible as
    // stated. Either the category isn't really 70km, the ascent isn't really
    // ~3000m, or this time belongs to a different category -- any of which
    // means the row is unverifiable, not merely imprecise. Do NOT re-add
    // this row to the fit without a sourced, verified course spec (e.g. the
    // category's own KML/GPX) -- see calibrate-perf.ts's former handling of
    // this row (superseded) for what happens when a guess like this is
    // allowed to bind the model: it forced the whole safety ceiling from
    // ~960 down to ~808 and inverted UTMB men (808) below this row's own
    // score (954), a lesser regional 70km outranking a greater world-class
    // 174km effort.
    note: 'UNVERIFIABLE, excluded from fit (P2 Q2 commit 5): implied average speed is 15.5 km/h over a 70km/~3000m-D+ mountain course -- faster than 2025 UTMB or OCC winners on comparable terrain, not physically credible. distanceKm/ascentM are estimates, not sourced. Kept for provenance only -- do not re-add to the fit without a real, verified course spec.',
  },
  {
    label: '崇礼168 2026, 50km, 杨春龙',
    distanceKm: 50,
    ascentM: 2299,
    descentM: 2299,
    hours: 4 + 24 / 60 + 47 / 3600,
    source: 'user-supplied result (time, real); distance/ascent estimated (see note)',
    confidence: 'low',
    excludeFromFit: true,
    note: 'UNVERIFIABLE, excluded from fit (P2 Q2 commit 5): distanceKm is the nominal category distance (not GPS-measured); ascentM is proportional to the 168km course\'s measured gain rate, not sourced. Kept for provenance only -- do not re-add to the fit without a real course spec.',
  },

  // ── 2025 UTMB Mont-Blanc week (international elites, P2 Q2 commit 3) ────
  // Course specs from the user's own project (D:\MyAIProject\cyber-trail-hud
  // \src\data\race-presets.js) -- nominal published race-preset figures,
  // NOT GPS-measured (same caveat as every course spec in this table).
  // Winner times from iRunFar's 2025 results coverage (irunfar.com/2025-
  // utmb-results, -ccc-results, -tds-results, -occ-results). UTMB/CCC/TDS/
  // OCC all start and finish in Chamonix (closed-loop courses), so this
  // table's existing "loop ⇒ D- ≈ D+" convention (see the 崇礼168 rows
  // above) is applied here too -- descent is not published per race, this
  // is a documented assumption, not a measured figure.
  //
  // None of these rows carry `expectedScore`: there is no independently-
  // published ITRA/official score for any athlete's performance in a
  // specific race, only real finish times (P2 §5 -- do not fabricate one).
  // The brief's "these winners should cluster in ~900-960" is a documented
  // ASSUMPTION about this cohort's calibre (elite/national-to-world-class),
  // not a per-athlete published number -- it steers the fit as a structural
  // band objective in calibrate-perf.ts (`internationalBandPenalty`), the
  // same way the 崇礼168 rows' cap/spread checks do, NOT as a numeric
  // regression anchor. `confidence` here documents trust in distanceKm/
  // ascentM/hours only (per the file-header note above).
  {
    label: '2025 UTMB, 174km/10000m D+, Tom Evans (men\'s winner)',
    distanceKm: 174,
    ascentM: 10000,
    descentM: 10000,
    hours: 19 + 18 / 60 + 58 / 3600,
    source: "course spec: cyber-trail-hud race-presets.js; result: irunfar.com/2025-utmb-results",
    confidence: 'medium',
    note: 'descentM assumed = ascentM (Chamonix loop course); course spec is nominal, not GPS-measured; time precise to the second',
  },
  {
    label: '2025 UTMB, 174km/10000m D+, Ruth Croft (women\'s winner)',
    distanceKm: 174,
    ascentM: 10000,
    descentM: 10000,
    hours: 22 + 56 / 60 + 23 / 3600,
    source: "course spec: cyber-trail-hud race-presets.js; result: irunfar.com/2025-utmb-results",
    confidence: 'medium',
    note: 'descentM assumed = ascentM (Chamonix loop course); course spec is nominal, not GPS-measured; time precise to the second',
  },
  {
    label: '2025 CCC, 101km/6100m D+, Francesco Puppi (men\'s winner)',
    distanceKm: 101,
    ascentM: 6100,
    descentM: 6100,
    hours: 10 + 6 / 60,
    source: "course spec: cyber-trail-hud race-presets.js; result: irunfar.com/2025-ccc-results",
    confidence: 'medium',
    note: 'time reported to the minute only (10:06), not the second; descentM assumed = ascentM; course spec is nominal, not GPS-measured',
  },
  {
    label: '2025 TDS, 153km/9000m D+, Antoine Charvolin (men\'s winner)',
    distanceKm: 153,
    ascentM: 9000,
    descentM: 9000,
    hours: 18 + 22 / 60 + 17 / 3600,
    source: "course spec: cyber-trail-hud race-presets.js; result: irunfar.com/2025-tds-results",
    confidence: 'medium',
    note: 'descentM assumed = ascentM (Chamonix loop course); course spec is nominal, not GPS-measured; time precise to the second',
  },
  {
    label: '2025 TDS, 153km/9000m D+, Careth Arnold (women\'s winner)',
    distanceKm: 153,
    ascentM: 9000,
    descentM: 9000,
    hours: 22 + 58 / 60 + 52 / 3600,
    source: "course spec: cyber-trail-hud race-presets.js; result: irunfar.com/2025-tds-results",
    confidence: 'medium',
    note: 'descentM assumed = ascentM (Chamonix loop course); course spec is nominal, not GPS-measured; time precise to the second',
  },
  {
    // Lower confidence than the other 5 international rows, and deliberately
    // NOT part of `internationalBandPenalty`'s numeric objective (see
    // calibrate-perf.ts) -- structural cap-avoidance check only, per the
    // brief's explicit instruction for this row.
    label: '2025 OCC, 57km/3500m D+ (nominal standard-course spec), Jim Walmsley (men\'s winner)',
    distanceKm: 57,
    ascentM: 3500,
    descentM: 3500,
    hours: 5,
    source: "course spec: cyber-trail-hud race-presets.js (standard OCC route); result: irunfar.com/2025-occ-results",
    confidence: 'low',
    note: 'the 2025 OCC ran on an ALTERNATE course -- 57km/3500m is the standard route\'s nominal spec, not confirmed for this edition; time reported to the minute only (~5:00); descentM assumed = ascentM. Compounded uncertainty -- structural (cap-avoidance) check only, excluded from the numeric elite-band objective.',
  },

  // ── Room for the user to add rows later ──────────────────────────────────
  // This table is the point: add a row (real distance/ascent/hours, and
  // `expectedScore` only if you have a real published number, otherwise
  // leave it off and it still participates in the structural checks) and
  // re-run `npx vite-node scripts/calibrate-perf.ts` to see how it moves
  // the fit. If the row's course spec/time is a genuine GUESS rather than
  // just lower-precision (see `excludeFromFit`'s doc comment above), set
  // `excludeFromFit: true` so it can't bind the model -- don't just mark it
  // `confidence: 'low'` and leave it in the structural gates.
]
