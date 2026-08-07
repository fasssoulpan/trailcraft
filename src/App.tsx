import { useEffect, useRef, useState } from 'react'
import { MapView } from './map/MapView'
import { ImportPanel } from './ui/ImportPanel'
import { TrackList } from './ui/TrackList'
import { ToolboxPanel } from './ui/ToolboxPanel'
import { CpPanel } from './ui/CpPanel'
import { PacePanel } from './ui/PacePanel'
import { SegmentTable } from './ui/SegmentTable'
import { ProjectToolbar } from './ui/ProjectToolbar'
import { ProfileCanvas } from './profile/ProfileCanvas'
import { useAppStore } from './state/appStore'
import { loadSourceMemory, saveSourceMemory } from './state/persist'
import './App.css'

function App() {
  // Collapsed by default: the map should get the majority of the vertical
  // space by default, and the segment table (a full data table) is heavy
  // enough that it deserves to be an explicit ask, not always-on real estate.
  const [segmentsOpen, setSegmentsOpen] = useState(false)
  const sourceMemory = useAppStore((s) => s.sourceMemory)
  // 首次挂载后本地写入还没触发时,不应该把"空对象"的初始 state 覆盖回
  // IndexedDB,把加载完成前那次 useEffect(依赖 sourceMemory)误当作"用户
  // 清空了记忆"而写坏已保存的数据。
  const hydrated = useRef(false)

  useEffect(() => {
    let cancelled = false
    loadSourceMemory()
      .then((m) => {
        if (cancelled) return
        if (Object.keys(m).length > 0) useAppStore.setState({ sourceMemory: m })
        hydrated.current = true
      })
      .catch(() => {
        hydrated.current = true
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated.current) return
    void saveSourceMemory(sourceMemory)
  }, [sourceMemory])

  return (
    <div className="app-layout">
      <aside className="app-layout__sidebar">
        <ProjectToolbar />
        <ImportPanel />
        <TrackList />
        <ToolboxPanel />
        <CpPanel />
        <PacePanel />
      </aside>
      <div className="app-layout__main">
        <div className="app-layout__map">
          <MapView />
        </div>
        <div className="app-layout__segments">
          <button
            type="button"
            className="app-layout__segments-toggle"
            onClick={() => setSegmentsOpen((v) => !v)}
          >
            {segmentsOpen ? '▾ 收起分段表' : '▸ 展开分段表'}
          </button>
          {segmentsOpen && (
            <div className="app-layout__segments-body">
              <SegmentTable />
            </div>
          )}
        </div>
        <div className="app-layout__profile">
          <ProfileCanvas />
        </div>
      </div>
    </div>
  )
}

export default App
