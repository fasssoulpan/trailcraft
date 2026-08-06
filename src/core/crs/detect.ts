import type { Crs } from '../model/track'

export interface DetectInput { creator?: string; fileName?: string }
export interface DetectResult { crs: Crs; confidence: 'high' | 'unknown'; reason: string }

const WGS84_PAT = /coros|garmin|suunto|strava|polar|wahoo|amazfit|huami|apple|gpx.?studio|caltopo|komoot/i
const GCJ02_PAT = /两步路|foooooot|六只脚|lvye|行者|imxingzhe|xingzhe|奥维|ovital|高德|amap|keep/i
const BD09_PAT = /百度|baidu/i

export function detectCrs(input: DetectInput, sourceMemory: Record<string, Crs>): DetectResult {
  const sig = `${input.creator ?? ''} ${input.fileName ?? ''}`
  if (input.creator && sourceMemory[input.creator])
    return { crs: sourceMemory[input.creator], confidence: 'high', reason: 'remembered source' }
  if (BD09_PAT.test(sig)) return { crs: 'bd09', confidence: 'high', reason: 'creator/filename matches baidu' }
  if (GCJ02_PAT.test(sig)) return { crs: 'gcj02', confidence: 'high', reason: 'creator/filename matches cn-app' }
  if (WGS84_PAT.test(sig)) return { crs: 'wgs84', confidence: 'high', reason: 'creator/filename matches device' }
  return { crs: 'wgs84', confidence: 'unknown', reason: 'no signal; require user confirm' }
}
