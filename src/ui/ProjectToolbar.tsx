import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { serializeProject, deserializeProject, type ProjectFile } from '../core/model/project'
import { saveProject, loadProject, listProjects } from '../state/persist'
import { trackToGpx } from '../core/export/gpxExport'
import type { Crs } from '../core/model/track'
import { deriveDefaultProjectName } from './projectName'
import { Section } from './primitives/Section'
import { Button } from './primitives/Button'

/**
 * Blob + object URL 是本项目"无后端"约束下下载文件的唯一方式(见 core/export
 * 的注释:没有服务器可以生成一个真实下载链接)。用完必须 revoke,否则每次
 * 导出都会泄漏一个 object URL,长时间会话下会累积。
 */
function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ProjectToolbar() {
  const tracks = useAppStore((s) => s.tracks)
  const cps = useAppStore((s) => s.cps)
  const paceParams = useAppStore((s) => s.paceParams)
  const statsOptions = useAppStore((s) => s.statsOptions)
  const raceStartTime = useAppStore((s) => s.raceStartTime)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const loadProjectData = useAppStore((s) => s.loadProjectData)

  const [projectName, setProjectName] = useState(() => deriveDefaultProjectName(undefined))
  // Whether the user has ever manually touched the name field (typed into
  // it, or opened/imported a project that comes with its own saved name).
  // Once true, importing/switching tracks must stop silently overriding
  // whatever name is currently showing -- otherwise the very "derive from
  // the active track" fix meant to reduce name collisions would itself
  // clobber a name the user deliberately chose.
  const [nameTouched, setNameTouched] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [projectList, setProjectList] = useState<string[] | undefined>()
  const [gpxCrs, setGpxCrs] = useState<Crs>('wgs84')

  const importFileRef = useRef<HTMLInputElement>(null)

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  // Keep the default name following the active track's name (see
  // src/ui/projectName.ts for why) as long as the user hasn't overridden it.
  useEffect(() => {
    if (nameTouched) return
    setProjectName(deriveDefaultProjectName(activeTrack?.meta.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTrack?.meta.name, nameTouched])

  function currentProjectFile(): ProjectFile {
    return serializeProject(projectName, tracks, cps, paceParams, statsOptions, raceStartTime)
  }

  async function handleSave() {
    try {
      // db.put('projects', project, project.properties.name) in persist.ts
      // keys projects by name -- saving under a name that already exists
      // silently replaces its entire content with no way to recover the
      // original. Ask before that happens; only proceed on confirmation.
      const existingNames = await listProjects()
      if (existingNames.includes(projectName)) {
        const confirmed = window.confirm(`工程 "${projectName}" 已存在，保存将覆盖原有内容，确定要覆盖吗？`)
        if (!confirmed) {
          setMessage('已取消保存')
          return
        }
      }
      await saveProject(currentProjectFile())
      setMessage(`已保存工程 "${projectName}"`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleOpenList() {
    try {
      const names = await listProjects()
      setProjectList(names)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleOpen(name: string) {
    try {
      const p = await loadProject(name)
      if (!p) {
        setMessage(`未找到工程 "${name}"`)
        return
      }
      loadProjectData(deserializeProject(p))
      setProjectName(name)
      setNameTouched(true) // an explicitly-opened project's name must stick
      setProjectList(undefined)
      setMessage(`已打开工程 "${name}"`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  function handleExportJson() {
    downloadBlob(`${projectName}.trailcraft.json`, JSON.stringify(currentProjectFile(), null, 2), 'application/json')
  }

  async function handleImportJsonFile(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as ProjectFile
      loadProjectData(deserializeProject(parsed))
      setProjectName(parsed.properties.name)
      setNameTouched(true) // an explicitly-imported project's name must stick
      setMessage(`已导入工程 "${parsed.properties.name}"`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  function handleExportGpx() {
    const track = tracks.find((t) => t.id === activeTrackId)
    if (!track) {
      setMessage('请先在轨迹列表中选择一条轨迹再导出 GPX')
      return
    }
    // Scope to this track's own CPs (trackId) -- cps holds every track's
    // checkpoints, and a single-track GPX export must not leak waypoints
    // that are anchored against a different track's geometry.
    const gpx = trackToGpx(track, cps.filter((c) => c.trackId === track.id), gpxCrs)
    downloadBlob(`${track.meta.name}.gpx`, gpx, 'application/gpx+xml')
  }

  return (
    <Section
      title="工程存档"
      description="「工程」= 这个软件里的一份存档：把当前所有轨迹、CP 点、配速与关门设置打包成一份，下次打开接着用。保存/打开走浏览器本地存储；导出 JSON 是存成文件，用来备份或换一台电脑；导出 GPX 则是把某一条轨迹单独给手表或别的软件用。"
    >
      <div className="project-toolbar">
        <input
          type="text"
          className="project-toolbar__name"
          value={projectName}
          onChange={(e) => {
            setNameTouched(true)
            setProjectName(e.target.value)
          }}
          placeholder="工程名称"
        />
        <div className="project-toolbar__row">
          <Button onClick={() => void handleSave()}>保存工程</Button>
          <Button onClick={() => void handleOpenList()}>打开工程</Button>
          <Button onClick={handleExportJson}>导出工程 JSON</Button>
          <Button onClick={() => importFileRef.current?.click()}>导入工程 JSON</Button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleImportJsonFile(f)
              e.target.value = ''
            }}
          />
        </div>

        {projectList && (
          <ul className="project-toolbar__list">
            {projectList.length === 0 && <li className="project-toolbar__hint">尚无已保存的工程</li>}
            {projectList.map((name) => (
              <li key={name}>
                <Button size="sm" onClick={() => void handleOpen(name)}>
                  {name}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="project-toolbar__row project-toolbar__row--gpx">
          <label>
            <input type="radio" name="gpx-crs" checked={gpxCrs === 'wgs84'} onChange={() => setGpxCrs('wgs84')} />
            WGS-84(设备/OSM)
          </label>
          <label>
            <input type="radio" name="gpx-crs" checked={gpxCrs === 'gcj02'} onChange={() => setGpxCrs('gcj02')} />
            GCJ-02(国内 App)
          </label>
          <Button onClick={handleExportGpx}>导出 GPX</Button>
        </div>

        {message && <p className="project-toolbar__hint">{message}</p>}
      </div>
    </Section>
  )
}
