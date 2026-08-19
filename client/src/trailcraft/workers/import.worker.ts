/// <reference lib="webworker" />
import { importFile } from '../core/pipeline/import'
import type { Crs } from '../core/model/track'

declare const self: DedicatedWorkerGlobalScope

interface ImportRequest {
  id: number
  fileName: string
  data: string | ArrayBuffer
  sourceMemory: Record<string, Crs>
  forcedCrs?: Crs
}

self.onmessage = async (e: MessageEvent) => {
  const { id, fileName, data, sourceMemory, forcedCrs } = e.data as ImportRequest
  try {
    const result = await importFile(fileName, data, sourceMemory, forcedCrs)
    const p = result.track.points
    const transfers = [p.lon.buffer, p.lat.buffer, p.ele?.buffer, p.time?.buffer, p.hr?.buffer, p.cumDist?.buffer]
      .filter((b): b is ArrayBuffer => !!b)
    self.postMessage({ id, ok: true, result }, transfers)
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) })
  }
}
