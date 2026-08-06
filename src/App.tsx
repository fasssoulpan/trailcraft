import { MapView } from './map/MapView'
import { ImportPanel } from './ui/ImportPanel'
import { TrackList } from './ui/TrackList'
import './App.css'

function App() {
  return (
    <div className="app-layout">
      <aside className="app-layout__sidebar">
        <ImportPanel />
        <TrackList />
      </aside>
      <div className="app-layout__main">
        <div className="app-layout__map">
          <MapView />
        </div>
        {/* Elevation profile placeholder: the next task adds a Canvas chart
         * here, bidirectionally wired to appStore's hover state (reads it to
         * draw its cursor, writes it when the user hovers the profile
         * instead of the map). Left empty for now. */}
        <div className="app-layout__profile-placeholder" />
      </div>
    </div>
  )
}

export default App
