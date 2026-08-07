import { MapView } from './map/MapView'
import { ImportPanel } from './ui/ImportPanel'
import { TrackList } from './ui/TrackList'
import { ToolboxPanel } from './ui/ToolboxPanel'
import { ProfileCanvas } from './profile/ProfileCanvas'
import './App.css'

function App() {
  return (
    <div className="app-layout">
      <aside className="app-layout__sidebar">
        <ImportPanel />
        <TrackList />
        <ToolboxPanel />
      </aside>
      <div className="app-layout__main">
        <div className="app-layout__map">
          <MapView />
        </div>
        <div className="app-layout__profile">
          <ProfileCanvas />
        </div>
      </div>
    </div>
  )
}

export default App
