import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MapView } from './map/MapView'
import { FlyView } from './ui/FlyView'
import { ModeSwitch } from './ui/ModeSwitch'
import { LayerPanel } from './ui/LayerPanel'
import { ImportPanel } from './ui/ImportPanel'
import { TrackList } from './ui/TrackList'
import { ToolboxPanel } from './ui/ToolboxPanel'
import { CpPanel } from './ui/CpPanel'
import { PacePanel } from './ui/PacePanel'
import { PerformancePanel } from './ui/PerformancePanel'
import { ExportPanel } from './ui/ExportPanel'
import { SegmentTable } from './ui/SegmentTable'
import { ProjectToolbar } from './ui/ProjectToolbar'
import { ProfileCanvas } from './profile/ProfileCanvas'
import { Splitter } from './ui/Splitter'
import { useAppStore } from './state/appStore'
import { loadSourceMemory, saveSourceMemory } from './state/persist'
import { clamp, loadLayoutSizes, saveLayoutSizes, SIDEBAR_COLLAPSED_WIDTH, type LayoutSizes } from './state/layout'
import { MapDebugBadge } from './ui/MapDebugBadge'
import { ThemeToggle } from './ui/ThemeToggle'
import './App.css'

// Minimums/maximums for the two user-resizable panes. The map itself has no
// explicit min/max here -- it's whatever's left over from flex:1 auto once
// the sidebar and profile take their share -- but MAP_MIN_WIDTH/HEIGHT are
// exactly the numbers the splitters subtract when computing THEIR maximums,
// which is what actually keeps the map from being squeezed to nothing (the
// zero-height-canvas bug fixed alongside this: see src/map/trackLayer.ts).
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 560
const PROFILE_MIN = 120
const PROFILE_MAX = 480
const MAP_MIN_WIDTH = 280
const MAP_MIN_HEIGHT = 160
const SPLITTER_SIZE = 6

function App() {
  // Collapsed by default: the map should get the majority of the vertical
  // space by default, and the segment table (a full data table) is heavy
  // enough that it deserves to be an explicit ask, not always-on real estate.
  const [segmentsOpen, setSegmentsOpen] = useState(false)
  const mode = useAppStore((s) => s.mode)
  const sourceMemory = useAppStore((s) => s.sourceMemory)
  // 首次挂载后本地写入还没触发时,不应该把"空对象"的初始 state 覆盖回
  // IndexedDB,把加载完成前那次 useEffect(依赖 sourceMemory)误当作"用户
  // 清空了记忆"而写坏已保存的数据。
  const hydrated = useRef(false)

  const [sizes, setSizes] = useState<LayoutSizes>(() => loadLayoutSizes())
  // Mirrors `sizes` for the splitters' onCommit handlers, which only know
  // the dimension they themselves just changed and need the *other*
  // dimension's current value to persist the full { sidebarWidth,
  // profileHeight } pair without going stale across renders.
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  const appLayoutRef = useRef<HTMLDivElement | null>(null)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const segmentsRef = useRef<HTMLDivElement | null>(null)

  // Collapsing/restoring never touches sizes.sidebarWidth/profileHeight --
  // it only flips the boolean, so the numeric size a pane restores to is
  // always whatever it was before it was collapsed, never a default.
  function toggleSidebar() {
    setSizes((s) => {
      const next = { ...s, sidebarCollapsed: !s.sidebarCollapsed }
      saveLayoutSizes(next)
      return next
    })
  }
  function toggleProfile() {
    setSizes((s) => {
      const next = { ...s, profileCollapsed: !s.profileCollapsed }
      saveLayoutSizes(next)
      return next
    })
  }

  const sidebarMax = () => {
    const el = appLayoutRef.current
    if (!el) return SIDEBAR_MAX
    return Math.min(SIDEBAR_MAX, el.clientWidth - MAP_MIN_WIDTH - SPLITTER_SIZE)
  }
  const profileMax = () => {
    const el = mainRef.current
    if (!el) return PROFILE_MAX
    const segmentsH = segmentsRef.current?.clientHeight ?? 0
    return Math.min(PROFILE_MAX, el.clientHeight - MAP_MIN_HEIGHT - SPLITTER_SIZE - segmentsH)
  }

  // A size restored from a previous, larger window (or just never validated
  // yet) could violate this window's constraints -- re-clamp once real
  // layout is available. Runs once on mount; deliberately not on every
  // window resize (that's a separate concern from "the user dragged a
  // splitter" and the flex layout + MapView's own ResizeObserver already
  // keep the map itself correct as the window resizes).
  useLayoutEffect(() => {
    setSizes((prev) => {
      const sidebarWidth = clamp(prev.sidebarWidth, SIDEBAR_MIN, sidebarMax())
      const profileHeight = clamp(prev.profileHeight, PROFILE_MIN, profileMax())
      if (sidebarWidth === prev.sidebarWidth && profileHeight === prev.profileHeight) return prev
      return { ...prev, sidebarWidth, profileHeight }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    <div className="app-layout" ref={appLayoutRef}>
      {sizes.sidebarCollapsed ? (
        // Collapsed to a thin always-visible strip -- see App.css's own
        // comment on this class for why the map's minimums don't need to
        // account for this width (it's far below SIDEBAR_MIN already).
        <aside className="app-layout__sidebar-collapsed" style={{ width: SIDEBAR_COLLAPSED_WIDTH }}>
          <button
            type="button"
            className="app-layout__sidebar-collapsed-toggle"
            onClick={toggleSidebar}
            aria-expanded={false}
            aria-label="展开侧边栏"
          >
            ▸
          </button>
        </aside>
      ) : (
        <aside
          className="app-layout__sidebar"
          style={{ width: sizes.sidebarWidth, flexBasis: sizes.sidebarWidth }}
        >
          {/* Pinned, not scrolled away with the rest of the panels: this is the
           * app's primary mode toggle, and burying it at the top of a long
           * scrolling column made it unfindable once any track was loaded. */}
          <div className="app-layout__sidebar-pinned">
            <div className="app-layout__sidebar-pinned-row">
              <ModeSwitch />
              <ThemeToggle />
              <button
                type="button"
                className="app-layout__sidebar-collapse-btn"
                onClick={toggleSidebar}
                aria-expanded={true}
                aria-label="收起侧边栏"
              >
                ◂
              </button>
            </div>
          </div>
          <LayerPanel />
          <ProjectToolbar />
          <ImportPanel />
          <TrackList />
          <ToolboxPanel />
          <CpPanel />
          <PacePanel />
          <PerformancePanel />
          <ExportPanel />
        </aside>
      )}
      {!sizes.sidebarCollapsed && (
        <Splitter
          orientation="vertical"
          value={sizes.sidebarWidth}
          min={SIDEBAR_MIN}
          getMax={sidebarMax}
          onChange={(sidebarWidth) => setSizes((s) => ({ ...s, sidebarWidth }))}
          onCommit={(sidebarWidth) => saveLayoutSizes({ ...sizesRef.current, sidebarWidth })}
          label="调整侧边栏宽度"
        />
      )}
      <div className="app-layout__main" ref={mainRef}>
        <div className="app-layout__map">
          {/* Only one of these is ever mounted -- switching modes must
           * genuinely destroy the previous engine (MapLibre's WebGL context
           * and tile fetching, or Cesium's Viewer) rather than just hiding
           * it, so two GPU-backed map engines are never running at once. */}
          {mode === 'plan' ? <MapView /> : <FlyView />}
          {import.meta.env.DEV && mode === 'plan' ? <MapDebugBadge /> : null}
        </div>
        <div className="app-layout__segments" ref={segmentsRef}>
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
        {!sizes.profileCollapsed && (
          <Splitter
            orientation="horizontal"
            value={sizes.profileHeight}
            min={PROFILE_MIN}
            getMax={profileMax}
            invert
            onChange={(profileHeight) => setSizes((s) => ({ ...s, profileHeight }))}
            onCommit={(profileHeight) => saveLayoutSizes({ ...sizesRef.current, profileHeight })}
            label="调整高程剖面图高度"
          />
        )}
        <div
          className="app-layout__profile"
          // Collapsed: no explicit height/flexBasis, so flex:0 0 auto (see
          // App.css) sizes this down to just the toggle button's own content
          // height instead of a hard-coded number -- see layout.ts's
          // SIDEBAR_COLLAPSED_WIDTH doc comment for why the profile pane
          // doesn't have an equivalent constant.
          style={sizes.profileCollapsed ? undefined : { height: sizes.profileHeight, flexBasis: sizes.profileHeight }}
        >
          {/* Same always-visible-toggle idiom as .app-layout__segments-toggle
           * above (SegmentTable's own collapse control) rather than a
           * separate style. */}
          <button
            type="button"
            className="app-layout__profile-toggle"
            onClick={toggleProfile}
            aria-expanded={!sizes.profileCollapsed}
            aria-label={sizes.profileCollapsed ? '展开高程剖面图' : '收起高程剖面图'}
          >
            {sizes.profileCollapsed ? '▸ 展开高程剖面图' : '▾ 收起高程剖面图'}
          </button>
          {!sizes.profileCollapsed && (
            <div className="app-layout__profile-body">
              <ProfileCanvas />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
