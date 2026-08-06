/**
 * 均匀抽稀索引:返回长度 ≤ maxPoints 的严格递增索引数组,首末点必含。
 *
 * Edge cases (deliberate, not accidental):
 * - `n <= 0` returns an empty array — there is nothing to decimate.
 * - `maxPoints <= 0` throws. Zero or negative target sizes are a caller
 *   bug (there is no sensible "decimate to nothing" result that still
 *   satisfies "first and last point must be included"), so we fail loudly
 *   instead of returning a misleading empty/garbage array.
 * - `maxPoints === 1` with `n > 1` is a genuine conflict between the two
 *   invariants this function promises: "length <= maxPoints" and "first
 *   and last point must be included" cannot both hold when only one slot
 *   is available for two distinct required indices. We resolve it by
 *   keeping the first/last-inclusion guarantee — the property every
 *   downstream caller (map rendering, hover-nearest lookup) actually
 *   depends on — and return a length-2 array `[0, n - 1]` instead of
 *   silently dividing by zero (the original `(n - 1) / (maxPoints - 1)`
 *   formula) or returning a single, ambiguous index.
 */
export function decimateIndices(n: number, maxPoints: number): Uint32Array {
  if (maxPoints <= 0) throw new Error(`decimateIndices: maxPoints must be >= 1, got ${maxPoints}`)
  if (n <= 0) return new Uint32Array(0)
  if (n <= maxPoints) return Uint32Array.from({ length: n }, (_, i) => i)
  if (maxPoints === 1) return Uint32Array.from([0, n - 1])

  const out = new Uint32Array(maxPoints)
  const step = (n - 1) / (maxPoints - 1)
  for (let i = 0; i < maxPoints; i++) out[i] = Math.round(i * step)
  out[maxPoints - 1] = n - 1
  return out
}
