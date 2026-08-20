/* 路线简报：浅色平台导航、四步任务轨道与地图/巡游主画布。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MapView } from './map/MapView'
import { FlyView } from './ui/FlyView'
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
import { useAppStore } from './state/appStore'
import { loadSourceMemory, saveSourceMemory } from './state/persist'
import { MapDebugBadge } from './ui/MapDebugBadge'
import './App.css'
import './RouteBrief.css'

type ToolView = 'workbench' | 'library'
type WorkflowStage = 'import' | 'edit' | 'analyse' | 'tour'

const STAGES: Array<{ id: WorkflowStage; label: string; kicker: string }> = [
  { id: 'import', label: '导入与校验', kicker: '01' },
  { id: 'edit', label: '路线编辑', kicker: '02' },
  { id: 'analyse', label: '赛前分析', kicker: '03' },
  { id: 'tour', label: '输出与巡游', kicker: '04' },
]

const TOOL_CARDS = [
  { title: '路线工作台', detail: '导入、校验、编辑并输出路线工程。', state: '可用', tool: 'workbench' as const },
  { title: '三维巡游', detail: '沿当前路线检查地形、镜头与关键帧。', state: '可用', tool: 'tour' as const },
  { title: '赛前简报', detail: '汇总路线距离、爬升、CP 与风险。', state: '即将推出', tool: undefined },
  { title: '补给与配速', detail: '基于地形与关门时间生成执行策略。', state: '即将推出', tool: undefined },
  { title: '表现工具', detail: '分析实跑记录、训练负荷与恢复线索。', state: '即将推出', tool: undefined },
]

function formatDistance(meters: number | undefined) {
  if (!meters || !Number.isFinite(meters)) return '—'
  return `${(meters / 1000).toFixed(1)} km`
}

function App() {
  const [toolView, setToolView] = useState<ToolView>('workbench')
  const [stage, setStage] = useState<WorkflowStage>('import')
  const [insightOpen, setInsightOpen] = useState(true)
  const [profileOpen, setProfileOpen] = useState(true)
  const [segmentsOpen, setSegmentsOpen] = useState(false)
  const sourceMemory = useAppStore((s) => s.sourceMemory)
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const cps = useAppStore((s) => s.cps)
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  const hydrated = useRef(false)

  const activeTrack = useMemo(() => tracks.find((track) => track.id === activeTrackId), [tracks, activeTrackId])
  const distance = activeTrack?.points.cumDist?.[activeTrack.points.cumDist.length - 1]
  const elevationGain = useMemo(() => {
    const elevations = activeTrack?.points.ele
    if (!elevations || elevations.length < 2) return undefined
    let gain = 0
    for (let index = 1; index < elevations.length; index += 1) gain += Math.max(0, elevations[index] - elevations[index - 1])
    return gain
  }, [activeTrack])
  const checkpointCount = useMemo(() => cps.filter((cp) => cp.trackId === activeTrackId).length, [cps, activeTrackId])

  useEffect(() => {
    let cancelled = false
    loadSourceMemory()
      .then((memory) => {
        if (!cancelled && Object.keys(memory).length > 0) useAppStore.setState({ sourceMemory: memory })
        hydrated.current = true
      })
      .catch(() => { hydrated.current = true })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (hydrated.current) void saveSourceMemory(sourceMemory)
  }, [sourceMemory])

  function activateStage(next: WorkflowStage) {
    setToolView('workbench')
    setStage(next)
    setMode(next === 'tour' ? 'fly' : 'plan')
    if (next !== 'import') setInsightOpen(true)
  }

  function openTool(tool: 'workbench' | 'tour') {
    if (tool === 'tour') activateStage('tour')
    else activateStage('import')
  }

  function renderInsight() {
    if (stage === 'import') {
      return <><StageHeader number="01" title="导入与校验" description="导入路线后，先确认坐标与高程是否可信。" /><div className="route-brief__primary-task"><span>下一步</span><strong>导入并校验路线</strong><p>支持 GPX、KML、FIT；全程仅在当前浏览器处理。</p><label htmlFor="trailcraft-route-import">选择路线文件 <b aria-hidden="true">→</b></label></div><ImportPanel /><div className="route-brief__secondary-tools"><TrackList /><ProjectToolbar /><LayerPanel /></div></>
    }
    if (stage === 'edit') {
      return <><StageHeader number="02" title="路线编辑" description="沿活动路线设置 CP、配速与关门判断。" /><ToolboxPanel /><CpPanel /><PacePanel /><LayerPanel /></>
    }
    if (stage === 'analyse') {
      return <><StageHeader number="03" title="赛前分析" description="将路线数据整理成能够执行的判断。" /><PerformancePanel /><LayerPanel /></>
    }
    return <><StageHeader number="04" title="输出与巡游" description="从当前路线进入三维地形、镜头与输出流程。" /><ExportPanel /><div className="route-brief__tour-note"><strong>三维巡游</strong><span>{activeTrack ? '已绑定当前活动路线。' : '先导入并选择一条路线。'}</span></div></>
  }

  if (toolView === 'library') {
    return (
      <div className="tool-platform">
        <PlatformNav view={toolView} onWorkbench={() => setToolView('workbench')} onLibrary={() => setToolView('library')} onTour={() => activateStage('tour')} />
        <main className="tool-library" id="main-content">
          <section className="tool-library__hero">
            <div><p className="eyebrow">TRAILCRAFT TOOLS</p><h1>为每一段山路，找到下一步。</h1><p>从路线校验到三维巡游，所有工具围绕一次更从容的出发。</p></div>
            <img src="/manus-storage/trailcraft-hero-ridge_fafb23ee.jpg" alt="山脊与云雾中的越野跑路线地貌" />
          </section>
          <section className="tool-library__grid" aria-label="TrailCraft 工具库">
            {TOOL_CARDS.map((card) => (
              <article className={`tool-card${card.tool ? ' tool-card--active' : ''}`} key={card.title}>
                <span className="tool-card__state">{card.state}</span><h2>{card.title}</h2><p>{card.detail}</p>
                {card.tool ? <button type="button" onClick={() => openTool(card.tool)}>打开工具 <span aria-hidden="true">→</span></button> : <span className="tool-card__coming">规划中</span>}
              </article>
            ))}
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="tool-platform">
      <PlatformNav view={toolView} onWorkbench={() => setToolView('workbench')} onLibrary={() => setToolView('library')} onTour={() => activateStage('tour')} />
      <main className="route-brief" id="main-content">
        <section className="route-brief__intro">
          <div><p className="eyebrow">ROUTE WORKBENCH</p><h1>{activeTrack ? activeTrack.meta.name : '从一条路线开始。'}</h1><p>{activeTrack ? '路线已载入。选择下一步，把数据变成赛前决定。' : '导入 GPX、KML 或 FIT；文件仅在当前浏览器中处理。'}</p></div>
          <div className="route-brief__metrics" aria-label="当前路线摘要">
            <Metric label="路线" value={activeTrack ? '已载入' : '待导入'} /><Metric label="距离" value={formatDistance(distance)} /><Metric label="爬升" value={elevationGain === undefined ? '待校验' : `+${Math.round(elevationGain)} m`} /><Metric label="CP" value={activeTrack ? `${checkpointCount} 个` : '—'} />
          </div>
        </section>
        <nav className={`route-brief__steps route-brief__steps--${stage}`} aria-label="路线工作步骤">
          {STAGES.map((item) => <button key={item.id} type="button" className={stage === item.id ? 'is-active' : ''} onClick={() => activateStage(item.id)}><span>{item.kicker}</span>{item.label}</button>)}
        </nav>
        <section className={`route-brief__workspace${mode === 'fly' ? ' route-brief__workspace--fly' : ''}`}>
          <div className="route-brief__canvas">
            {mode === 'fly' ? <FlyView /> : <MapView />}
            {mode === 'plan' && !activeTrack ? <RouteCanvasGuide /> : null}
            {import.meta.env.DEV && mode === 'plan' ? <MapDebugBadge /> : null}
          </div>
          <aside className={`route-brief__insight${insightOpen ? ' is-open' : ''}`}>
            <button type="button" className="route-brief__insight-toggle" onClick={() => setInsightOpen((open) => !open)} aria-expanded={insightOpen}>{insightOpen ? '收起操作区' : '打开操作区'}</button>
            {insightOpen && <div className="route-brief__insight-body">{renderInsight()}</div>}
          </aside>
        </section>
        <section className="route-brief__data-band">
          <div className="route-brief__data-band-head"><span>高程与分段</span><div><button type="button" onClick={() => setProfileOpen((open) => !open)}>{profileOpen ? '收起高程' : '展开高程'}</button><button type="button" onClick={() => setSegmentsOpen((open) => !open)}>{segmentsOpen ? '收起分段' : '查看分段'}</button></div></div>
          {profileOpen && <div className="route-brief__profile"><ProfileCanvas /></div>}
          {segmentsOpen && <div className="route-brief__segments"><SegmentTable /></div>}
        </section>
      </main>
    </div>
  )
}

function PlatformNav({ view, onWorkbench, onLibrary, onTour }: { view: ToolView; onWorkbench: () => void; onLibrary: () => void; onTour: () => void }) {
  return <header className="platform-nav"><button className="platform-nav__brand" type="button" onClick={onWorkbench} aria-label="返回 TrailCraft 路线工作台"><img src="/manus-storage/trailcraft-mark_eda8cf83.png" alt="" /><span>TrailCraft<small>ROUTE BRIEF</small></span></button><nav aria-label="主要导航"><button type="button" className={view === 'workbench' ? 'is-current' : ''} onClick={onWorkbench}>路线工作台</button><button type="button" className={view === 'library' ? 'is-current' : ''} onClick={onLibrary}>工具库</button><button type="button" onClick={onTour}>三维巡游</button></nav><span className="platform-nav__status">本地优先 · 现有图源</span></header>
}

function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function StageHeader({ number, title, description }: { number: string; title: string; description: string }) { return <header className="stage-header"><span>{number}</span><div><h2>{title}</h2><p>{description}</p></div></header> }
function RouteCanvasGuide() { return <div className="route-canvas-guide"><span className="route-canvas-guide__code">ROUTE / 00</span><svg viewBox="0 0 440 112" aria-hidden="true"><path d="M8 96 C65 88 74 36 128 52 S202 95 244 63 S305 14 352 40 S390 80 432 15" /><circle cx="8" cy="96" r="4" /><circle cx="432" cy="15" r="5" /></svg><div><strong>路线画布已就绪</strong><span>导入后将自动检查坐标、距离与高程。</span><label htmlFor="trailcraft-route-import">导入并校验路线 <b aria-hidden="true">→</b></label></div></div> }

export default App
