import type { Crs } from '../model/track'

export interface DetectInput { creator?: string; fileName?: string }
export interface DetectResult { crs: Crs; confidence: 'high' | 'unknown'; reason: string }

// Latin alternatives are wrapped with letter-based boundaries `(?<![a-zA-Z])...(?![a-zA-Z])`
// so a pattern like "apple" doesn't match as a bare substring inside e.g. "Snapple
// Fitness" (which would otherwise silently produce a high-confidence, wrong CRS
// guess). Plain `\b` isn't used because it treats digits/underscore as word
// characters too, which would break real filenames like "foooooot_12345.kml".
// CJK alternatives are intentionally left as bare substrings: `\b` does not behave
// usefully against CJK scripts (there is no letter/non-letter distinction to anchor
// on), and CJK app names are unlikely to collide as accidental substrings the way
// short Latin words do.
const WGS84_PAT = /(?<![a-zA-Z])(?:coros|garmin|suunto|strava|polar|wahoo|amazfit|huami|apple|gpx.?studio|caltopo|komoot)(?![a-zA-Z])/i
const GCJ02_PAT = /两步路|六只脚|行者|奥维|高德|(?<![a-zA-Z])(?:foooooot|lvye|imxingzhe|xingzhe|ovital|amap|keep)(?![a-zA-Z])/i
const BD09_PAT = /百度|(?<![a-zA-Z])baidu(?![a-zA-Z])/i

export function detectCrs(input: DetectInput, sourceMemory: Record<string, Crs>): DetectResult {
  const sig = `${input.creator ?? ''} ${input.fileName ?? ''}`
  if (input.creator && sourceMemory[input.creator])
    return { crs: sourceMemory[input.creator], confidence: 'high', reason: 'remembered source' }
  if (BD09_PAT.test(sig)) return { crs: 'bd09', confidence: 'high', reason: 'creator/filename matches baidu' }
  if (GCJ02_PAT.test(sig)) return { crs: 'gcj02', confidence: 'high', reason: 'creator/filename matches cn-app' }
  if (WGS84_PAT.test(sig)) return { crs: 'wgs84', confidence: 'high', reason: 'creator/filename matches device' }
  return { crs: 'wgs84', confidence: 'unknown', reason: 'no signal; require user confirm' }
}
