import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Where the real-track fixtures live, and whether any given one is present.
 *
 * Four test files used to each carry their own copy of this path literal.
 * That is the same duplication that has already gone stale twice in this
 * project (the perf-model constants, the playback speed ladder), so it is
 * resolved once here.
 *
 * Resolution order:
 *   1. `TRAILCRAFT_TESTDATA` -- an explicit override always wins.
 *   2. The author's full local corpus, if this is that machine. It holds the
 *      multi-hundred-megabyte recordings (a 330k-point GPX among them) that
 *      are far too large to commit, and the perf assertions against them have
 *      caught real regressions, so they must keep running where they exist.
 *   3. `samples/` in the repo -- a deliberately small subset (~7MB) covering
 *      GPX/KML/FIT and both planned and recorded track kinds, committed so
 *      that a fresh clone on any other machine still exercises the real-data
 *      paths rather than silently skipping all of them.
 */
const LOCAL_CORPUS = 'C:/Users/Administrator/Desktop/越野跑地图软件开发/测试'
const REPO_SAMPLES = resolve(__dirname, '../samples')

export const dataDir =
  process.env.TRAILCRAFT_TESTDATA ?? (existsSync(LOCAL_CORPUS) ? LOCAL_CORPUS : REPO_SAMPLES)

/**
 * True when one specific fixture is readable.
 *
 * Guarding on the *directory* (what these suites did before) is only correct
 * when the directory is all-or-nothing. Since `samples/` is deliberately a
 * subset, a directory-level guard would let a suite start and then throw on
 * the first `readFileSync` of a file that was never committed. Per-file
 * guards let the small fixtures run everywhere and the huge ones skip
 * cleanly where they are absent.
 */
export function hasFixture(...segments: string[]): boolean {
  return existsSync(join(dataDir, ...segments))
}
