import { useAppStore } from '../state/appStore'
import { isoToLocalInputValue, localInputValueToIso } from '../core/util/localTime'

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

export function PacePanel() {
  const paceParams = useAppStore((s) => s.paceParams)
  const raceStartTime = useAppStore((s) => s.raceStartTime)
  const setPaceParams = useAppStore((s) => s.setPaceParams)
  const setRaceStartTime = useAppStore((s) => s.setRaceStartTime)

  const model = paceParams.model ?? 'practical'

  return (
    <div className="pace-panel">
      <h3 className="pace-panel__title">配速与关门预警</h3>

      <div className="pace-panel__row pace-panel__row--model">
        <button
          type="button"
          className={model === 'practical' ? 'pace-panel__model-btn pace-panel__model-btn--active' : 'pace-panel__model-btn'}
          onClick={() => setPaceParams({ model: 'practical' })}
        >
          实用档
        </button>
        <button
          type="button"
          className={model === 'tobler' ? 'pace-panel__model-btn pace-panel__model-btn--active' : 'pace-panel__model-btn'}
          onClick={() => setPaceParams({ model: 'tobler' })}
        >
          Tobler 徒步函数
        </button>
      </div>

      <label className="pace-panel__field">
        平路配速(mm:ss / 公里)
        <input
          type="text"
          defaultValue={secToMmSs(paceParams.flatPaceSecPerKm)}
          key={paceParams.flatPaceSecPerKm}
          onBlur={(e) => {
            const sec = mmSsToSec(e.target.value)
            if (sec !== undefined) setPaceParams({ flatPaceSecPerKm: sec })
          }}
        />
      </label>

      <label className="pace-panel__field">
        爬升垂直速度 VAM(米/小时)
        <input
          type="number"
          min={0}
          step={10}
          value={paceParams.vamMPerH}
          onChange={(e) => setPaceParams({ vamMPerH: Number(e.target.value) })}
        />
      </label>

      <label className="pace-panel__field">
        下坡折算系数(秒/米下降)
        <input
          type="number"
          min={0}
          step={0.05}
          value={paceParams.descentFactor}
          onChange={(e) => setPaceParams({ descentFactor: Number(e.target.value) })}
        />
      </label>

      <label className="pace-panel__field">
        疲劳减速(% / 小时)
        <input
          type="number"
          min={0}
          step={0.5}
          value={paceParams.fatiguePctPerHour}
          onChange={(e) => setPaceParams({ fatiguePctPerHour: Number(e.target.value) })}
        />
      </label>

      <label className="pace-panel__field">
        起跑时间
        <input
          type="datetime-local"
          value={isoToLocalInputValue(raceStartTime)}
          onChange={(e) => {
            const iso = localInputValueToIso(e.target.value)
            if (iso) setRaceStartTime(iso)
          }}
        />
      </label>
    </div>
  )
}
