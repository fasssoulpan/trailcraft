import { useAppStore } from '../state/appStore'
import { isoToLocalInputValue, localInputValueToIso } from '../core/util/localTime'
import { Section } from './primitives/Section'
import { Field } from './primitives/Field'
import { SegmentedControl } from './primitives/SegmentedControl'

/**
 * 平路配速对普通人来说以 mm:ss/公里 思考远比裸秒数直观(“6 分配速”而不是
 * “360 秒”),因此仅在这一个字段上做展示层的秒数<->mm:ss 转换,PaceParams
 * 内部(以及 core/pace/models.ts 的所有计算)仍然全程用秒——转换只发生在
 * UI 边界,不污染核心模型。
 */
function secToMmSs(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function mmSsToSec(value: string): number | undefined {
  const m = /^(\d+):([0-5]?\d)$/.exec(value.trim())
  if (!m) return undefined
  return Number(m[1]) * 60 + Number(m[2])
}

const MODEL_OPTIONS: { value: 'practical' | 'tobler'; label: string }[] = [
  { value: 'practical', label: '实用档' },
  { value: 'tobler', label: 'Tobler 徒步函数' },
]

export function PacePanel() {
  const paceParams = useAppStore((s) => s.paceParams)
  const raceStartTime = useAppStore((s) => s.raceStartTime)
  const setPaceParams = useAppStore((s) => s.setPaceParams)
  const setRaceStartTime = useAppStore((s) => s.setRaceStartTime)

  const model = paceParams.model ?? 'practical'

  return (
    <Section
      title="配速与关门预警"
      description="设置预计配速模型，用于估算各 CP 的到达时间并与关门时间比对。"
    >
      <Field label="配速模型">
        <SegmentedControl
          value={model}
          options={MODEL_OPTIONS}
          onChange={(v) => setPaceParams({ model: v })}
          ariaLabel="配速模型"
        />
      </Field>

      <Field label="平路配速(mm:ss / 公里)">
        <input
          type="text"
          defaultValue={secToMmSs(paceParams.flatPaceSecPerKm)}
          key={paceParams.flatPaceSecPerKm}
          onBlur={(e) => {
            const sec = mmSsToSec(e.target.value)
            if (sec !== undefined) setPaceParams({ flatPaceSecPerKm: sec })
          }}
        />
      </Field>

      <Field label="爬升垂直速度 VAM(米/小时)">
        <input
          type="number"
          min={0}
          step={10}
          value={paceParams.vamMPerH}
          onChange={(e) => setPaceParams({ vamMPerH: Number(e.target.value) })}
        />
      </Field>

      <Field label="下坡折算系数(秒/米下降)">
        <input
          type="number"
          min={0}
          step={0.05}
          value={paceParams.descentFactor}
          onChange={(e) => setPaceParams({ descentFactor: Number(e.target.value) })}
        />
      </Field>

      <Field label="疲劳减速(% / 小时)">
        <input
          type="number"
          min={0}
          step={0.5}
          value={paceParams.fatiguePctPerHour}
          onChange={(e) => setPaceParams({ fatiguePctPerHour: Number(e.target.value) })}
        />
      </Field>

      <Field label="起跑时间">
        <input
          type="datetime-local"
          value={isoToLocalInputValue(raceStartTime)}
          onChange={(e) => {
            const iso = localInputValueToIso(e.target.value)
            if (iso) setRaceStartTime(iso)
          }}
        />
      </Field>
    </Section>
  )
}
