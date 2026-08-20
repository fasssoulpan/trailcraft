/* 路线简报设计提醒：速算可从工具库直接打开，无需导入路线。 */
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { calculateSpi } from '../core/perf/score'
import { computeKmEffortV2, computeQuickSplits, segmentLengthKm } from '../core/perf/quickCalc'
import { RACE_PRESETS, RACE_PRESET_CATEGORIES, type RacePreset, type RacePresetCategory } from '../core/perf/racePresets'
import { formatPaceMinPerKm, formatDurationHM, formatKm, formatMeters, PERF_DISCLAIMER } from './perfFormat'
import { Button } from './primitives/Button'
import { SegmentedControl } from './primitives/SegmentedControl'
import { Field } from './primitives/Field'
import { StatTile, StatGrid } from './primitives/StatTile'

/**
 * Track-free "quick calculator" mode (user-requested addition -- see
 * `core/perf/quickCalc.ts`'s file comment for the feature and the pure
 * logic it reuses). A second, always-available entry point next to
 * `PerformancePanel`'s 表现分析 button: that one needs a real recorded
 * track, this one needs nothing but hand-typed numbers.
 *
 * Not React-tested, same convention as `PerformancePanel.tsx` (no jsdom in
 * this project) -- kept "thin" for the same reason: every number this
 * renders comes from `quickCalc.ts`'s unit-tested pure functions or
 * `score.ts#calculateSpi` (already tested by `tests/core/score.test.ts`),
 * this file itself only wires state to JSX.
 */
export function QuickCalcPanel({ autoOpen = false, onAutoOpened }: { autoOpen?: boolean; onAutoOpened?: () => void }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!autoOpen) return
    setOpen(true)
    onAutoOpened?.()
  }, [autoOpen, onAutoOpened])
  return (
    <>
      <Button className="qc-entry-button" onClick={() => setOpen(true)}>
        表现分速算
      </Button>
      {open && <QuickCalcModal onClose={() => setOpen(false)} />}
    </>
  )
}

function QuickCalcModal({ onClose }: { onClose: () => void }) {
  const paceParams = useAppStore((s) => s.paceParams)

  const [category, setCategory] = useState<RacePresetCategory>(RACE_PRESET_CATEGORIES[0])
  const [distanceKm, setDistanceKm] = useState(100)
  const [ascentM, setAscentM] = useState(4000)
  // Loop-course default (P2 brief: "default descent to equal ascent...and
  // say so in the UI rather than silently assuming") -- tracked separately
  // from ascent (not derived from it) so a manual edit sticks even if
  // ascent changes afterwards; only a fresh preset pick or an ascent edit
  // BEFORE the user has ever touched descent re-syncs it (see
  // `descentTouched` below).
  const [descentM, setDescentM] = useState(4000)
  const [descentTouched, setDescentTouched] = useState(false)
  const [hh, setHh] = useState(20)
  const [mm, setMm] = useState(0)
  const [ss, setSs] = useState(0)

  const finishTimeSec = Math.max(0, hh) * 3600 + Math.max(0, mm) * 60 + Math.max(0, ss)

  function applyPreset(p: RacePreset) {
    setDistanceKm(p.dist)
    setAscentM(p.elev)
    if (!descentTouched) setDescentM(p.elev)
  }

  function onAscentChange(v: number) {
    setAscentM(v)
    if (!descentTouched) setDescentM(v)
  }

  const kmEffortV2 = computeKmEffortV2(distanceKm, ascentM, descentM)
  const hours = finishTimeSec / 3600
  const spi = calculateSpi(kmEffortV2, hours, 1.0)
  const avgPaceSecPerKm = distanceKm > 0 && finishTimeSec > 0 ? finishTimeSec / distanceKm : undefined

  const splits = useMemo(
    () => computeQuickSplits(distanceKm, ascentM, descentM, finishTimeSec, paceParams),
    [distanceKm, ascentM, descentM, finishTimeSec, paceParams],
  )
  const segLenKm = segmentLengthKm(distanceKm)

  const presetsInCategory = RACE_PRESETS.filter((p) => p.category === category)

  return (
    <div className="perf-modal__backdrop" onClick={onClose}>
      <div
        className="perf-modal"
        role="dialog"
        aria-modal="true"
        aria-label="表现分速算"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="perf-modal__header">
          <h3 className="perf-modal__title">表现分速算</h3>
          <Button variant="ghost" size="sm" className="perf-modal__close" onClick={onClose} aria-label="关闭">
            ×
          </Button>
        </div>

        <div className="perf-modal__body">
          <p className="perf-modal__audit-hint">
            无需上传轨迹文件——手动输入距离、爬升、完赛用时即可估算表现分，并按分段给出配速参考。
          </p>

          <section className="perf-modal__section">
            <h4 className="perf-modal__section-title">赛事预设</h4>
            <SegmentedControl
              className="qc-preset-tabs"
              size="sm"
              value={category}
              options={RACE_PRESET_CATEGORIES.map((c) => ({ value: c, label: c }))}
              onChange={setCategory}
              ariaLabel="赛事预设分类"
            />
            <div className="qc-preset-list">
              {presetsInCategory.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="qc-preset-item"
                  onClick={() => applyPreset(p)}
                  title="点击填入距离与爬升，仍可手动修改"
                >
                  <span className="qc-preset-item__name">{p.name}</span>
                  <span className="qc-preset-item__spec">
                    {p.dist}km / {p.elev}m
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="perf-modal__section">
            <h4 className="perf-modal__section-title">参数输入</h4>
            <div className="qc-field-row">
              <Field label="距离(km)">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={distanceKm}
                  onChange={(e) => setDistanceKm(Number(e.target.value))}
                />
              </Field>
              <Field label="爬升(m)">
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={ascentM}
                  onChange={(e) => onAscentChange(Number(e.target.value))}
                />
              </Field>
              <Field label="下降(m)">
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={descentM}
                  onChange={(e) => {
                    setDescentTouched(true)
                    setDescentM(Number(e.target.value))
                  }}
                />
              </Field>
            </div>
            <p className="perf-env-note">
              下降默认等于爬升(按环线赛道估算)，可手动修改为点对点赛道的真实下降。
            </p>

            <div className="qc-field-row">
              <Field label="完赛用时" className="qc-field--time">
                <span className="qc-time-inputs">
                  <input type="number" min={0} value={hh} onChange={(e) => setHh(Number(e.target.value))} /> 时
                  <input type="number" min={0} max={59} value={mm} onChange={(e) => setMm(Number(e.target.value))} /> 分
                  <input type="number" min={0} max={59} value={ss} onChange={(e) => setSs(Number(e.target.value))} /> 秒
                </span>
              </Field>
            </div>
          </section>

          <section className="perf-modal__section">
            <h4 className="perf-modal__section-title">结果</h4>
            <p className="perf-disclaimer">{PERF_DISCLAIMER}</p>
            {spi ? (
              <>
                <div className="perf-score">
                  <span className="perf-score__value tabular-nums">{spi.score}</span>
                  <span className="perf-score__level">{spi.level}</span>
                </div>
                <StatGrid>
                  <StatTile label="里程当量(km-effort)" value={kmEffortV2.toFixed(1)} />
                  <StatTile label="平均配速" value={formatPaceMinPerKm(avgPaceSecPerKm)} />
                  <StatTile label="完赛用时" value={formatDurationHM(finishTimeSec)} />
                </StatGrid>
                <p className="perf-modal__audit-hint">
                  用于计算表现分的里程当量为 {kmEffortV2.toFixed(1)}，用时 {formatDurationHM(finishTimeSec)}
                  ——分数并非黑盒，可据此复核。此结果未做环境(温湿度/海拔)修正。
                </p>
              </>
            ) : (
              <p className="perf-modal__gate-text">请输入有效的距离、爬升/下降与完赛用时(均需大于 0)。</p>
            )}
          </section>

          <section className="perf-modal__section">
            <h4 className="perf-modal__section-title">各分段预估用时</h4>
            <p className="perf-env-note">
              没有真实轨迹，这里假设爬升/下降沿全程按里程均匀分布，再用配速面板(配速与关门预警)里的配速参数
              ——含疲劳减速——把完赛用时逐段分配开，越往后的分段因为疲劳累积而更慢。这只是一份配速参考，
              <strong>不是针对该赛道真实坡度剖面的预测</strong>：真实的逐段爬升/坡度需要导入 GPX
              轨迹，用侧边栏「表现分析」的分段表查看。当前按每 {segLenKm} km 一段切分。
            </p>
            {splits.length === 0 ? (
              <p className="perf-modal__gate-text">请先输入有效的距离与完赛用时以生成分段估算</p>
            ) : (
              <div className="perf-table-scroll">
                <table className="perf-table tabular-nums">
                  <thead>
                    <tr>
                      <th>分段</th>
                      <th>里程</th>
                      <th>爬升</th>
                      <th>下降</th>
                      <th>本段用时</th>
                      <th>累计用时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {splits.map((s) => (
                      <tr key={s.index}>
                        <td>{s.index}</td>
                        <td>{formatKm(s.distanceKm * s.index * 1000)}</td>
                        <td>{formatMeters(s.ascentM)}</td>
                        <td>{formatMeters(s.descentM)}</td>
                        <td>{formatDurationHM(s.segmentTimeSec)}</td>
                        <td>{formatDurationHM(s.cumulativeTimeSec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
