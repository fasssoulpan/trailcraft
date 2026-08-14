import { useState } from 'react'
import { useAppStore } from '../state/appStore'
import type { Track } from '../core/model/track'
import type { StatsOptions } from '../core/stats/segments'
import { resolveTrackKind } from '../core/perf/trackKind'
import { computePerformance } from '../core/perf/score'
import {
  formatPaceMinPerKm,
  formatDurationHM,
  formatKm,
  formatMeters,
  formatGradePct,
  summarizeGradeBands,
  significantClimbs,
  envCompensationNote,
  perfAvailability,
  PERF_DISCLAIMER,
} from './perfFormat'
import { QuickCalcPanel } from './QuickCalcPanel'

/**
 * 表现报告面板(P2 §3.3,里程碑 Q3)。一个可关闭的浮层/弹窗,由侧边栏按钮
 * 打开——不是常驻的侧边栏分区:P1 已经因为侧边栏太挤而把模式切换钉住防止
 * 被滚动出视野,再塞一个常驻分区只会让问题更糟。
 *
 * 不做 React 组件测试(项目没有 jsdom 组件测试环境,brief 明确把新增这套
 * 环境列为范围外)——`perfFormat.ts` 已经把这个面板依赖的所有纯展示逻辑
 * (格式化、坡度分桶、可用性判定)拆出来单测,这个文件本身只做数据取用和
 * JSX 拼装,刻意保持"薄"以降低未测试代码的风险面。
 */
export function PerformancePanel() {
  const [open, setOpen] = useState(false)
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const statsOptions = useAppStore((s) => s.statsOptions)

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  return (
    <div className="perf-entry">
      <button
        type="button"
        className="perf-entry__button"
        disabled={!activeTrack}
        onClick={() => setOpen(true)}
      >
        表现分析
      </button>
      {!activeTrack && <p className="perf-entry__hint">请先在轨迹列表中选择一条轨迹</p>}

      {open && activeTrack && (
        <PerformanceModal track={activeTrack} statsOptions={statsOptions} onClose={() => setOpen(false)} />
      )}

      <QuickCalcPanel />
    </div>
  )
}

function PerformanceModal({
  track,
  statsOptions,
  onClose,
}: {
  track: Track
  statsOptions: StatsOptions
  onClose: () => void
}) {
  const resolved = resolveTrackKind(track)
  const availability = perfAvailability(resolved.kind)

  return (
    <div className="perf-modal__backdrop" onClick={onClose}>
      <div
        className="perf-modal"
        role="dialog"
        aria-modal="true"
        aria-label="表现报告"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="perf-modal__header">
          <h3 className="perf-modal__title">表现报告 · {track.meta.name}</h3>
          <button type="button" className="perf-modal__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="perf-modal__body">
          {availability.status !== 'available' ? (
            <div className="perf-modal__gate">
              <h4 className="perf-modal__gate-title">{availability.title}</h4>
              {availability.message.split('\n').map((line, i) => (
                <p key={i} className="perf-modal__gate-text">
                  {line}
                </p>
              ))}
            </div>
          ) : (
            <PerformanceReport track={track} statsOptions={statsOptions} />
          )}
        </div>
      </div>
    </div>
  )
}

function PerformanceReport({
  track,
  statsOptions,
}: {
  track: Track
  statsOptions: StatsOptions
}) {
  const analysis = computePerformance(track, statsOptions)

  if (!analysis.applicable) {
    // Track kind gate already passed (this component only renders when
    // perfAvailability said 'available'), so any remaining not-applicable
    // reason is one of computePerformance's OTHER gates (no elevation/time,
    // too few points, a degenerate total) -- its own message is already
    // written for direct UI display, see score.ts's PerformanceNotApplicable.
    return <p className="perf-modal__gate-text">{analysis.message}</p>
  }

  const avgPaceSecPerKm = analysis.totalDistanceM > 0 ? analysis.totalTimeS / (analysis.totalDistanceM / 1000) : undefined
  const gradeBands = summarizeGradeBands(analysis.gradeSegments)
  const climbs = significantClimbs(analysis.gradeSegments)

  return (
    <>
      <section className="perf-modal__section">
        <h4 className="perf-modal__section-title">核心指标</h4>
        <p className="perf-disclaimer">{PERF_DISCLAIMER}</p>
        <div className="perf-score">
          <span className="perf-score__value">{analysis.spiScore}</span>
          <span className="perf-score__level">{analysis.spiLevel}</span>
        </div>
        <div className="perf-metrics-grid">
          <div className="perf-metric">
            <span className="perf-metric__label">距离</span>
            <span className="perf-metric__value">{formatKm(analysis.totalDistanceM)}</span>
          </div>
          <div className="perf-metric">
            <span className="perf-metric__label">累计爬升</span>
            <span className="perf-metric__value">{formatMeters(analysis.totalAscentM)}</span>
          </div>
          <div className="perf-metric">
            <span className="perf-metric__label">累计下降</span>
            <span className="perf-metric__value">{formatMeters(analysis.totalDescentM)}</span>
          </div>
          <div className="perf-metric">
            <span className="perf-metric__label">用时</span>
            <span className="perf-metric__value">{formatDurationHM(analysis.totalTimeS)}</span>
          </div>
          <div className="perf-metric">
            <span className="perf-metric__label">平均配速</span>
            <span className="perf-metric__value">{formatPaceMinPerKm(avgPaceSecPerKm)}</span>
          </div>
          <div className="perf-metric">
            <span className="perf-metric__label">里程当量(km-effort)</span>
            <span className="perf-metric__value">{analysis.kmEffortV2.toFixed(1)}</span>
          </div>
        </div>
        <p className="perf-modal__audit-hint">
          用于计算表现分的里程当量为 {analysis.kmEffortV2.toFixed(1)},用时 {formatDurationHM(analysis.totalTimeS)}
          ——分数并非黑盒,可据此复核。
        </p>
      </section>

      <section className="perf-modal__section">
        <h4 className="perf-modal__section-title">坡度分布</h4>
        {analysis.gradeSegments.length === 0 ? (
          <p className="perf-modal__gate-text">轨迹过短或数据不足，无法按坡度分段</p>
        ) : (
          <div className="perf-grade-bars">
            {gradeBands.map((b) => (
              <div key={b.type} className="perf-bar-row">
                <span className="perf-bar-row__label">{b.label}</span>
                <div className="perf-bar">
                  <div className={`perf-bar__fill perf-bar__fill--${b.type}`} style={{ width: `${b.pct}%` }} />
                </div>
                <span className="perf-bar-row__value">
                  {formatKm(b.distanceM)} ({b.pct.toFixed(0)}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="perf-modal__section">
        <h4 className="perf-modal__section-title">主要爬坡</h4>
        {climbs.length === 0 ? (
          <p className="perf-modal__gate-text">未检测到显著爬坡段</p>
        ) : (
          <table className="perf-table">
            <thead>
              <tr>
                <th>区间</th>
                <th>长度</th>
                <th>爬升</th>
                <th>平均坡度</th>
              </tr>
            </thead>
            <tbody>
              {climbs.map((c, i) => (
                <tr key={i}>
                  <td>
                    {formatKm(c.startDist)} - {formatKm(c.endDist)}
                  </td>
                  <td>{formatKm(c.distance)}</td>
                  <td>{formatMeters(c.ascent)}</td>
                  <td>{formatGradePct(c.avgGrade)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="perf-modal__section">
        <h4 className="perf-modal__section-title">深度分析</h4>
        <p className="perf-env-note">{envCompensationNote(analysis.envCompensation)}</p>
        {analysis.splits.length === 0 ? (
          <p className="perf-modal__gate-text">轨迹过短，无法按公里切分</p>
        ) : (
          <div className="perf-table-scroll">
            <table className="perf-table">
              <thead>
                <tr>
                  <th>公里</th>
                  <th>配速</th>
                  <th>GAP</th>
                  <th>爬升</th>
                  <th>下降</th>
                </tr>
              </thead>
              <tbody>
                {analysis.splits.map((s) => (
                  <tr key={s.km}>
                    <td>{s.km}</td>
                    <td>{formatPaceMinPerKm(s.pace)}</td>
                    <td>{formatPaceMinPerKm(s.gap)}</td>
                    <td>{formatMeters(s.ascent)}</td>
                    <td>{formatMeters(s.descent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
