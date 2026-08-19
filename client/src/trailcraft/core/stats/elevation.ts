/**
 * 滑动窗口均值平滑。NaN 不参与窗口平均(缺失点不应拉低/拉高邻居的平滑值),
 * 也不被"发明"出来:如果 i 处本身就是 NaN(未记录),输出仍是 NaN,而不是
 * 用邻居的平均值去填补——那样会伪造一个设备从未测到的读数。
 */
export function smoothElevation(ele: Float32Array, window = 5): Float32Array {
  const n = ele.length
  const out = new Float32Array(n)
  const half = Math.floor(window / 2)
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(ele[i])) {
      out[i] = NaN
      continue
    }
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    let sum = 0
    let count = 0
    for (let j = lo; j <= hi; j++) {
      const v = ele[j]
      if (!Number.isNaN(v)) {
        sum += v
        count++
      }
    }
    out[i] = count > 0 ? sum / count : NaN
  }
  return out
}

/**
 * 阈值滞回(hysteresis)累计爬升/下降。保持一个"参考海拔",只有当当前点相对
 * 参考点的偏离达到 threshold 才计入对应方向并把参考点移动到当前点,否则忽略。
 *
 * 真实 GPS/气压高度计的读数即使在原地不动时也会持续抖动几米,若逐点相邻差分
 * 求和,总爬升会被严重高估;不同平台(Strava/Garmin/ITRA)公布的爬升数字
 * 相差 15%~30%,几乎全部来自这个阈值选择的不同——因此阈值必须可调、可标定,
 * 不能写死。
 */
export function computeGainLoss(ele: Float32Array, threshold = 5): { gain: number; loss: number } {
  let gain = 0
  let loss = 0
  let ref: number | undefined
  for (let i = 0; i < ele.length; i++) {
    const e = ele[i]
    if (Number.isNaN(e)) continue
    if (ref === undefined) {
      ref = e
      continue
    }
    if (e - ref >= threshold) {
      gain += e - ref
      ref = e
    } else if (ref - e >= threshold) {
      loss += ref - e
      ref = e
    }
  }
  return { gain, loss }
}
