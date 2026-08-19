import type { Crs } from '../core/model/track'
import type { ImportResult } from '../core/pipeline/import'

interface ImportRequest {
  id: number
  fileName: string
  data: string | ArrayBuffer
  sourceMemory: Record<string, Crs>
  forcedCrs?: Crs
}

interface ImportResponseOk { id: number; ok: true; result: ImportResult }
interface ImportResponseErr { id: number; ok: false; error: string }
type ImportResponse = ImportResponseOk | ImportResponseErr

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, { resolve: (r: ImportResult) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as ImportResponse
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    }
    worker.onerror = (e: ErrorEvent) => {
      // A worker-level error (e.g. syntax error) doesn't carry a request id;
      // reject every in-flight request so callers don't hang forever.
      Array.from(pending.entries()).forEach(([id, p]) => {
        pending.delete(id)
        p.reject(new Error(e.message))
      })
    }
  }
  return worker
}

export function importInWorker(
  fileName: string,
  data: string | ArrayBuffer,
  sourceMemory: Record<string, Crs>,
  forcedCrs?: Crs,
): Promise<ImportResult> {
  const w = getWorker()
  const id = nextId++
  const request: ImportRequest = { id, fileName, data, sourceMemory, forcedCrs }
  return new Promise<ImportResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // Note: the input buffer is intentionally NOT transferred (only cloned) so the
    // caller's ArrayBuffer (e.g. a File/FileReader result) stays usable afterward.
    w.postMessage(request)
  })
}
