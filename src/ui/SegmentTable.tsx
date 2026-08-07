import { useState } from 'react'
import { useAppStore } from '../state/appStore'
import { computeSegments, calibrateThreshold } from '../core/stats/segments'

export function SegmentTable() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const cps = useAppStore((s) => s.cps)
  const statsOptions = useAppStore((s) => s.statsOptions)
  const setStatsOptions = useAppStore((s) => s.setStatsOptions)

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

  const segments = computeSegments(activeTrack, cps, statsOptions)
  const total = segments.reduce(
    (acc, s) => ({ dist: acc.dist + s.dist, gain: acc.gain + s.gain, loss: acc.loss + s.loss }),
    { dist: 0, gain: 0, loss: 0 },
  )

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
            </tr>
          </thead>
          <tbody>
            {segments.map((s, i) => (
              <tr key={i}>
                <td>
                  {s.fromName} → {s.toName}
                </td>
                <td>{(s.dist / 1000).toFixed(2)}</td>
                <td>{s.gain.toFixed(0)}</td>
                <td>{s.loss.toFixed(0)}</td>
                <td>{(s.gainRate * 1000).toFixed(0)}</td>
                <td>{(s.netSlope * 100).toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>全程合计</td>
              <td>{(total.dist / 1000).toFixed(2)}</td>
              <td>{total.gain.toFixed(0)}</td>
              <td>{total.loss.toFixed(0)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
