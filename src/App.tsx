import { useState } from 'react'
import { MapView } from './map/MapView'
import { ImportPanel } from './ui/ImportPanel'
import { TrackList } from './ui/TrackList'
import { ToolboxPanel } from './ui/ToolboxPanel'
import { CpPanel } from './ui/CpPanel'
import { SegmentTable } from './ui/SegmentTable'
import { ProfileCanvas } from './profile/ProfileCanvas'
import './App.css'

function App() {
  // Collapsed by default: the map should get the majority of the vertical
  // space by default, and the segment table (a full data table) is heavy
  // enough that it deserves to be an explicit ask, not always-on real estate.
  const [segmentsOpen, setSegmentsOpen] = useState(false)

  return (
    <div className="app-layout">
      <aside className="app-layout__sidebar">
        <ImportPanel />
        <TrackList />
        <ToolboxPanel />
        <CpPanel />
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
