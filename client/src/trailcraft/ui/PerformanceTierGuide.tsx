/* 路线简报设计提醒：分级卡必须解释当前路线当量下的用时，而不把社区估算伪装为官方认证。 */
import { PERFORMANCE_TIERS, performanceTierForScore, referenceHoursForScore } from '../core/perf/score'
import { formatDurationHM } from './perfFormat'

function timeForScore(kmEffort: number, score: number, envFactor: number) {
  const hours = referenceHoursForScore(kmEffort, score, envFactor)
  return hours === undefined ? undefined : formatDurationHM(hours * 3600)
}

function tierTimeLabel(min: number, max: number, kmEffort: number, envFactor: number) {
  const nextThreshold = min === 0 ? 500 : min
  const slow = timeForScore(kmEffort, nextThreshold, envFactor)
  const fast = max >= 900 ? timeForScore(kmEffort, 900, envFactor) : timeForScore(kmEffort, max, envFactor)
  if (!slow || !fast) return '等待有效路线当量'
  if (min === 0) return `≥ ${slow}`
  if (max >= 900) return `≤ ${fast}`
  return `${fast} — ${slow}`
}

export function PerformanceTierGuide({ score, kmEffort, envFactor = 1 }: { score: number; kmEffort: number; envFactor?: number }) {
  const current = performanceTierForScore(score)
  return (
    <section className="perf-tier-guide" aria-label="表现分与用时区间">
      <div className="perf-tier-guide__head"><div><h4>表现与用时区间</h4><p>按当前路线当量反推各分级参考用时，真实结果会随地面、气候和补给条件变化。</p></div><span>产品内参考分档</span></div>
      <div className="perf-tier-guide__grid">
        {PERFORMANCE_TIERS.map((tier) => <article key={tier.key} className={`perf-tier-card perf-tier-card--${tier.key}${current.key === tier.key ? ' is-current' : ''}`}><strong>{tier.label}</strong><span>{tier.min}–{tier.max} 分</span><b>{tierTimeLabel(tier.min, tier.max, kmEffort, envFactor)}</b><small>参考用时</small></article>)}
      </div>
      <p className="perf-tier-guide__note">该区间是产品内表现分解释，不等同于官方 ITRA 等级、资格或认证结果。</p>
    </section>
  )
}
