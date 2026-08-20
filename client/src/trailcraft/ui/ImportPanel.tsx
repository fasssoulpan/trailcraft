import { useState } from 'react'
import type { Crs } from '../core/model/track'
import type { ImportResult } from '../core/pipeline/import'
import { importInWorker } from '../workers/importClient'
import { useAppStore } from '../state/appStore'
import { Section } from './primitives/Section'
import { Button } from './primitives/Button'

// 内部预览环境中，Vite 的模块 Worker 偶尔不回传导入结果。主线程回退只在
// Worker 超时/失败后启用；正式恢复 Worker 后，常规大文件仍会保持非阻塞解析。
const WORKER_IMPORT_TIMEOUT_MS = 8_000

async function importWithFallback(
  fileName: string,
  data: string | ArrayBuffer,
  sourceMemory: Record<string, Crs>,
  forcedCrs?: Crs,
): Promise<ImportResult> {
  let timeoutId: number | undefined
  try {
    return await Promise.race([
      importInWorker(fileName, data, sourceMemory, forcedCrs),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('轨迹导入 Worker 超时')), WORKER_IMPORT_TIMEOUT_MS)
      }),
    ])
  } catch {
    const { importFile } = await import('../core/pipeline/import')
    return importFile(fileName, data, sourceMemory, forcedCrs)
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
  }
}

type FileStatus =
  | { phase: 'loading' }
  | { phase: 'needs-crs'; fileName: string; data: string | ArrayBuffer; result: ImportResult }
  | { phase: 'done'; name: string }
  | { phase: 'error'; message: string }

const ACCEPT = '.gpx,.kml,.fit,.kmz'

export function ImportPanel() {
  // fileName -> current status; a failed/pending file never blocks the rest of the batch.
  const [statuses, setStatuses] = useState<Record<string, FileStatus>>({})
  const addTrack = useAppStore((s) => s.addTrack)
  const addImportedCheckpoints = useAppStore((s) => s.addImportedCheckpoints)
  const rememberSource = useAppStore((s) => s.rememberSource)

  function setStatus(fileName: string, status: FileStatus) {
    setStatuses((s) => ({ ...s, [fileName]: status }))
  }

  async function importOne(file: File) {
    const fileName = file.name
    const ext = fileName.toLowerCase().split('.').pop()

    if (ext === 'kmz') {
      setStatus(fileName, {
        phase: 'error',
        message: 'KMZ 暂不支持,请先解压该文件并导入其中的 doc.kml',
      })
      return
    }

    setStatus(fileName, { phase: 'loading' })
    try {
      const data: string | ArrayBuffer = ext === 'fit' ? await file.arrayBuffer() : await file.text()
      // Read sourceMemory fresh at call time (not via a reactive hook value
      // captured at render): multiple files in one batch import concurrently,
      // and an earlier file's rememberSource() in the same batch should be
      // visible to a later file's detectCrs call.
      const result = await importWithFallback(fileName, data, useAppStore.getState().sourceMemory)
      if (result.detect.confidence === 'unknown') {
        setStatus(fileName, { phase: 'needs-crs', fileName, data, result })
        return
      }
      addTrack(result.track)
      addImportedCheckpoints(result.track, result.waypoints)
      setStatus(fileName, { phase: 'done', name: result.track.meta.name })
    } catch (err) {
      setStatus(fileName, { phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function resolveCrs(fileName: string, chosenCrs: Crs) {
    const status = statuses[fileName]
    if (!status || status.phase !== 'needs-crs') return
    setStatus(fileName, { phase: 'loading' })
    try {
      const result = await importWithFallback(status.fileName, status.data, useAppStore.getState().sourceMemory, chosenCrs)
      addTrack(result.track)
      addImportedCheckpoints(result.track, result.waypoints)
      if (result.track.meta.creator) rememberSource(result.track.meta.creator, chosenCrs)
      setStatus(fileName, { phase: 'done', name: result.track.meta.name })
    } catch (err) {
      setStatus(fileName, { phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    // Files are imported independently and in parallel; one failure must not
    // abort the others (each has its own status entry above).
    await Promise.all(Array.from(fileList).map((f) => importOne(f)))
  }

  return (
    <Section title="导入轨迹" description="导入 GPX / KML / FIT；坐标系待判定时须由操作者确认。">
      <div className="import-panel">
        <label className="import-panel__input-label">
          导入轨迹文件
          <input
            id="trailcraft-route-import"
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => {
              void handleFiles(e.target.files)
              e.target.value = '' // allow re-selecting the same file
            }}
          />
        </label>
        <ul className="import-panel__status-list">
          {Object.entries(statuses).map(([fileName, status]) => (
            <li key={fileName} className={`import-panel__status import-panel__status--${status.phase}`}>
              <span className="import-panel__file-name">{fileName}</span>
              {status.phase === 'loading' && <span> 导入中…</span>}
              {status.phase === 'done' && <span> 已导入:{status.name}</span>}
              {status.phase === 'error' && <span className="import-panel__error"> {status.message}</span>}
              {status.phase === 'needs-crs' && (
                <div className="import-panel__crs-prompt">
                  <p>
                    无法自动判断该轨迹的坐标系。选错坐标系会导致轨迹在地图上整体偏移数百米,请确认轨迹来源:
                  </p>
                  <Button size="sm" onClick={() => void resolveCrs(fileName, 'gcj02')}>
                    国内 App 轨迹(GCJ-02)
                  </Button>
                  <Button size="sm" onClick={() => void resolveCrs(fileName, 'wgs84')}>
                    GPS 设备轨迹(WGS-84)
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  )
}
