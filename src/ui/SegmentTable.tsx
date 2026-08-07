import { useState } from 'react'
import { useAppStore } from '../state/appStore'
import { computeSegments, calibrateThreshold } from '../core/stats/segments'
import { estimateArrivals, type WarnLevel } from '../core/pace/models'

/** h:mm,用于逐段耗时与全程合计耗时。 */
function formatDurationHM(sec: number): string {
  if (!Number.isFinite(sec)) return '--'
  const totalMin = Math.round(sec / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/** HH:mm(本地时区),用于预计到达 / 关门时间这类"某个时刻"的展示。 */
function formatClockHM(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const STATUS_LABEL: Record<WarnLevel, string> = { green: '安全', yellow: '紧张', red: '超时' }

export function SegmentTable() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const allCps = useAppStore((s) => s.cps)
  const statsOptions = useAppStore((s) => s.statsOptions)
  const setStatsOptions = useAppStore((s) => s.setStatsOptions)
  const paceParams = useAppStore((s) => s.paceParams)
  const raceStartTime = useAppStore((s) => s.raceStartTime)

  const [officialGain, setOfficialGain] = useState('')
  const [calibrateMessage, setCalibrateMessage] = useState<string | undefined>()

  const activeTrack = tracks.find((t) => t.id === activeTrackId)
  const threshold = statsOptions.threshold ?? 5

  if (!activeTrack) {
    return <p className="segment-table segment-table--empty">请先在轨迹列表中选择一条轨迹</p>
  }
  if (!activeTrack.points.cumDist) {
    return <p className="segment-table segment-table--empty">该轨迹缺少里程数据</p>
  }

  // Same trackId-scoping rule as CpPanel: s.cps spans every track, so this
  // must only compute/display segments against the active track's own CPs.
  const cps = allCps.filter((c) => c.trackId === activeTrack.id)
  const segments = computeSegments(activeTrack, cps, statsOptions)
  const total = segments.reduce(
    (acc, s) => ({ dist: acc.dist + s.dist, gain: acc.gain + s.gain, loss: acc.loss + s.loss }),
    { dist: 0, gain: 0, loss: 0 },
  )

  // segments 的切分边界与 computeSegments 内部完全一致:[起点, 各 CP(按
  // anchorIndex 排序), 终点]。segments[i] 的终点是 sortedCps[i](i < CP 数),
  // 最后一段(i === segments.length - 1)终点是"终点",没有对应 CP,关门时间
  // 自然是 undefined——这里必须用同一份排序规则重新推导 sortedCps,否则
  // cutoffsMs[i] 和 segments[i] 对不上号,预警会错配到相邻的 CP。
  const sortedCps = [...cps].sort((a, b) => a.anchorIndex - b.anchorIndex)
  const cutoffsMs = segments.map((_, i) => {
    if (i >= sortedCps.length) return undefined // 终点段,无关门时间
    const iso = sortedCps[i].cutoffTime
    if (!iso) return undefined
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? undefined : ms
  })
  const startMs = Date.parse(raceStartTime)
  const arrivals = Number.isNaN(startMs)
    ? undefined
    : estimateArrivals(segments, paceParams, startMs, cutoffsMs)
  const segTimesSec = arrivals?.map((a, i) => (a.etaMs - (i === 0 ? startMs : arrivals[i - 1].etaMs)) / 1000)
  const finishEtaMs = arrivals?.[arrivals.length - 1]?.etaMs

  function doCalibrate() {
    if (!activeTrack) return
    const gain = Number(officialGain)
    if (!Number.isFinite(gain) || gain <= 0) {
      setCalibrateMessage('请输入有效的官方总爬升(米,大于 0)')
      return
    }
    try {
      const best = calibrateThreshold(activeTrack, gain, statsOptions)
      setStatsOptions({ threshold: best })
      setCalibrateMessage(`已选阈值 ${best} m(目标总爬升 ${gain} m)`)
    } catch (err) {
      setCalibrateMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="segment-table">
      <div className="segment-table__controls">
        <label className="segment-table__field">
          爬升阈值:{threshold.toFixed(1)} m
          <input
            type="range"
            min={3}
            max={10}
            step={0.5}
            value={threshold}
            onChange={(e) => setStatsOptions({ threshold: Number(e.target.value) })}
          />
        </label>
        <p className="segment-table__hint">
          不同平台的爬升算法几乎都只是阈值不同,同一条轨迹在不同平台上算出的总爬升可相差 15%~30%,
          仅凭这一个参数就能解释绝大部分差异。
        </p>

        <div className="segment-table__calibrate">
          <label className="segment-table__field">
            对齐官方总爬升 (m)
            <input
              type="number"
              min={0}
              step={1}
              value={officialGain}
              onChange={(e) => setOfficialGain(e.target.value)}
            />
          </label>
          <button type="button" onClick={doCalibrate}>
            校准
          </button>
        </div>
        {calibrateMessage && <p className="segment-table__hint">{calibrateMessage}</p>}
        {finishEtaMs !== undefined && (
          <p className="segment-table__finish">
            预计完赛时间:{new Date(finishEtaMs).toLocaleString()}(用时 {formatDurationHM((finishEtaMs - startMs) / 1000)})
          </p>
        )}
        {arrivals === undefined && <p className="segment-table__hint">起跑时间无效,无法估算到达/关门预警</p>}
      </div>

      <div className="segment-table__scroll">
        <table className="segment-table__table">
          <thead>
            <tr>
              <th>段名</th>
              <th>距离 (km)</th>
              <th>爬升 (m)</th>
              <th>下降 (m)</th>
              <th>爬升率 (m/km)</th>
              <th>净坡度 (%)</th>
              <th>预计段时间 (h:mm)</th>
              <th>预计到达 (HH:mm)</th>
              <th>关门时间 (HH:mm)</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s, i) => {
              const arrival = arrivals?.[i]
              const segTimeSec = segTimesSec?.[i]
              const cutoffMs = cutoffsMs[i]
              return (
                <tr key={i}>
                  <td>
                    {s.fromName} → {s.toName}
                  </td>
                  <td>{(s.dist / 1000).toFixed(2)}</td>
                  <td>{s.gain.toFixed(0)}</td>
                  <td>{s.loss.toFixed(0)}</td>
                  <td>{(s.gainRate * 1000).toFixed(0)}</td>
                  <td>{(s.netSlope * 100).toFixed(1)}</td>
                  <td>{segTimeSec !== undefined ? formatDurationHM(segTimeSec) : '--'}</td>
                  <td>{arrival ? formatClockHM(arrival.etaMs) : '--'}</td>
                  <td>{cutoffMs !== undefined ? formatClockHM(cutoffMs) : '--'}</td>
                  <td className={arrival ? `segment-table__status segment-table__status--${arrival.level}` : undefined}>
                    {arrival ? STATUS_LABEL[arrival.level] : '--'}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>全程合计</td>
              <td>{(total.dist / 1000).toFixed(2)}</td>
              <td>{total.gain.toFixed(0)}</td>
              <td>{total.loss.toFixed(0)}</td>
              <td colSpan={2} />
              <td>{finishEtaMs !== undefined ? formatDurationHM((finishEtaMs - startMs) / 1000) : '--'}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
