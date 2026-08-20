/* 路线简报设计提醒：表现工具既是第03步分析，也是工具库可直达的真实能力。 */
import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import type { Track } from '../core/model/track'
import type { StatsOptions } from '../core/stats/segments'
import type { CheckPoint } from '../core/model/checkpoint'
import { resolveTrackKind } from '../core/perf/trackKind'
import { computePerformance } from '../core/perf/score'
import { computeSensorCoverage } from '../core/perf/sensorCoverage'
import { deriveInsightsForTrack } from '../core/perf/insights'
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
  summarizeSensorCoverage,
} from './perfFormat'
import { QuickCalcPanel } from './QuickCalcPanel'
import { Section } from './primitives/Section'
import { Button } from './primitives/Button'
import { StatTile, StatGrid } from './primitives/StatTile'

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
export function PerformancePanel({ launch, onLaunchHandled }: { launch?: 'quick' | 'track'; onLaunchHandled?: () => void }) {
  const [open, setOpen] = useState(false)
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const statsOptions = useAppStore((s) => s.statsOptions)
  const cps = useAppStore((s) => s.cps)

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  useEffect(() => {
    if (launch === 'track' && activeTrack) {
      setOpen(true)
      onLaunchHandled?.()
    }
  }, [activeTrack, launch, onLaunchHandled])

  return (
    <Section title="表现分析" description="打开完整表现报告（含表现分、坡度分布、主要爬坡、逐公里数据），或不带轨迹直接速算。">
      <div className="perf-entry">
        <Button variant="primary" disabled={!activeTrack} onClick={() => setOpen(true)}>
          表现分析
        </Button>
        {!activeTrack && <p className="perf-entry__hint">请先在轨迹列表中选择一条轨迹</p>}

        {open && activeTrack && (
          <PerformanceModal track={activeTrack} statsOptions={statsOptions} cps={cps} onClose={() => setOpen(false)} />
        )}

        <QuickCalcPanel autoOpen={launch === 'quick'} onAutoOpened={onLaunchHandled} />
      </div>
    </Section>
  )
}

function PerformanceModal({
  track,
  statsOptions,
  cps,
  onClose,
}: {
  track: Track
  statsOptions: StatsOptions
  cps: CheckPoint[]
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
          <Button variant="ghost" size="sm" className="perf-modal__close" onClick={onClose} aria-label="关闭">
            ×
          </Button>
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
            <PerformanceReport track={track} statsOptions={statsOptions} cps={cps} />
          )}
        </div>
      </div>
    </div>
  )
}

function PerformanceReport({
  track,
  statsOptions,
  cps,
}: {
  track: Track
  statsOptions: StatsOptions
  cps: CheckPoint[]
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
  const sensorRows = summarizeSensorCoverage(computeSensorCoverage(track.points))
  const insights = deriveInsightsForTrack(track, statsOptions, cps)

  return (
    <>
      <section className="perf-modal__section">
        <h4 className="perf-modal__section-title">核心指标</h4>
        <p className="perf-disclaimer">{PERF_DISCLAIMER}</p>
        <div className="perf-score">
          <span className="perf-score__value tabular-nums">{analysis.spiScore}</span>
          <span className="perf-score__level">{analysis.spiLevel}</span>
        </div>
        <StatGrid>
          <StatTile label="距离" value={formatKm(analysis.totalDistanceM)} />
          <StatTile label="累计爬升" value={formatMeters(analysis.totalAscentM)} />
          <StatTile label="累计下降" value={formatMeters(analysis.totalDescentM)} />
          <StatTile label="用时" value={formatDurationHM(analysis.totalTimeS)} />
          <StatTile label="平均配速" value={formatPaceMinPerKm(avgPaceSecPerKm)} />
          <StatTile label="里程当量(km-effort)" value={analysis.kmEffortV2.toFixed(1)} />
        </StatGrid>
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
          <table className="perf-table tabular-nums">
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
            <table className="perf-table tabular-nums">
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

      <section className="perf-modal__section">
        <h4 className="perf-modal__section-title">行动建议</h4>
        {insights.length === 0 ? (
          <p className="perf-modal__gate-text">本次数据未发现值得单独指出的模式</p>
        ) : (
          <ul className="perf-insights-list">
            {insights.map((ins, i) => (
              <li key={i} className="perf-insights-list__item">
                {ins.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="perf-modal__section">
        <h4 className="perf-modal__section-title">传感器覆盖</h4>
        <p className="perf-modal__audit-hint">
          在信任任何一项基于传感器的判断之前，先看它到底记录了多少——覆盖率低或缺失的读数不参与上面任何统计。
        </p>
        <table className="perf-table tabular-nums">
          <thead>
            <tr>
              <th>传感器</th>
              <th>覆盖率</th>
              <th>读数范围</th>
            </tr>
          </thead>
          <tbody>
            {sensorRows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>{r.present ? r.coverageLabel : '无数据'}</td>
                <td>{r.rangeLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
