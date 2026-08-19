/**
 * Race-distance/ascent presets for the track-free "quick calculator" mode
 * (user-requested addition, not a planned P2 milestone -- see
 * `src/core/perf/quickCalc.ts`'s file comment for the feature this feeds).
 *
 * Ported verbatim (name/dist/elev only -- category labels kept identical)
 * from the user's own project `cyber-trail-hud`'s
 * `src/data/race-presets.js` (39 entries, 3 categories: 国际经典/中国经典/
 * 按距离). No licence obstacle -- same provenance basis as
 * `core/perf/score.ts`'s and `core/pace/models.ts`'s ports from the same
 * project. `dist`/`elev` here are the reference's own course-spec figures
 * (km / m of ascent), not measured from any TrailCraft track -- same
 * "estimated course figures, not measured facts" caveat `score.ts`'s header
 * already carries for the international/崇礼168 calibration rows.
 */

export type RacePresetCategory = '国际经典' | '中国经典' | '按距离'

export interface RacePreset {
  category: RacePresetCategory
  name: string
  /** Course distance, km. */
  dist: number
  /** Course ascent (D+), m. */
  elev: number
}

export const RACE_PRESET_CATEGORIES: RacePresetCategory[] = ['国际经典', '中国经典', '按距离']

export const RACE_PRESETS: RacePreset[] = [
  // -- 国际经典 --
  { category: '国际经典', name: 'OCC', dist: 57, elev: 3500 },
  { category: '国际经典', name: 'CCC', dist: 101, elev: 6100 },
  { category: '国际经典', name: 'TDS', dist: 153, elev: 9000 },
  { category: '国际经典', name: 'UTMB', dist: 174, elev: 10000 },
  { category: '国际经典', name: 'Lavaredo 120K', dist: 120, elev: 5800 },
  { category: '国际经典', name: 'Western States 100', dist: 161, elev: 5500 },
  { category: '国际经典', name: 'Hardrock 100', dist: 161, elev: 10000 },
  { category: '国际经典', name: 'Transgrancanaria 128K', dist: 128, elev: 7500 },
  { category: '国际经典', name: 'Diagonale des Fous', dist: 165, elev: 9600 },
  { category: '国际经典', name: 'MIUT 115K', dist: 115, elev: 7200 },
  // -- 中国经典 --
  { category: '中国经典', name: '港百 HK100', dist: 103, elev: 5300 },
  { category: '中国经典', name: '柴古唐斯 85K', dist: 85, elev: 5600 },
  { category: '中国经典', name: '柴古唐斯 105K', dist: 105, elev: 6700 },
  { category: '中国经典', name: '崇礼168', dist: 168, elev: 6800 },
  { category: '中国经典', name: '崇礼100', dist: 100, elev: 4000 },
  { category: '中国经典', name: '大五朝台 70K', dist: 70, elev: 3800 },
  { category: '中国经典', name: '大理100', dist: 100, elev: 4339 },
  { category: '中国经典', name: '宁海100 by UTMB', dist: 100, elev: 5000 },
  { category: '中国经典', name: '高黎贡 165K', dist: 165, elev: 8500 },
  { category: '中国经典', name: '三峡 169K', dist: 169, elev: 10300 },
  { category: '中国经典', name: '环四姑娘山 60K', dist: 60, elev: 4000 },
  { category: '中国经典', name: '龙腾亚丁 50K', dist: 50, elev: 3500 },
  { category: '中国经典', name: '云丘山 100K by UTMB', dist: 100, elev: 4500 },
  { category: '中国经典', name: 'TNF100 北京', dist: 100, elev: 5000 },
  // -- 按距离 --
  { category: '按距离', name: '30K 低爬升', dist: 30, elev: 800 },
  { category: '按距离', name: '30K 山地', dist: 30, elev: 1500 },
  { category: '按距离', name: '50K 低爬升', dist: 50, elev: 1500 },
  { category: '按距离', name: '50K 中爬升', dist: 50, elev: 2500 },
  { category: '按距离', name: '50K 高爬升', dist: 50, elev: 4000 },
  { category: '按距离', name: '70K 中爬升', dist: 70, elev: 3000 },
  { category: '按距离', name: '70K 高爬升', dist: 70, elev: 4500 },
  { category: '按距离', name: '80K 中爬升', dist: 80, elev: 3500 },
  { category: '按距离', name: '80K 高爬升', dist: 80, elev: 5000 },
  { category: '按距离', name: '100K 低爬升', dist: 100, elev: 3000 },
  { category: '按距离', name: '100K 中爬升', dist: 100, elev: 4500 },
  { category: '按距离', name: '100K 高爬升', dist: 100, elev: 6500 },
  { category: '按距离', name: '百英里 中爬升', dist: 161, elev: 6000 },
  { category: '按距离', name: '百英里 高爬升', dist: 168, elev: 9500 },
  { category: '按距离', name: '200K+', dist: 210, elev: 12000 },
]
