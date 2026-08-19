import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * Guards for the sidebar's scroll/hit-target layout.
 *
 * These assert that specific declarations are still present, which is a
 * weak form of test -- it cannot prove the sidebar renders correctly, only
 * that the rules the correct rendering depends on have not been dropped.
 * That is worth having anyway, because the bug they guard against is
 * invisible in code review and was introduced by an otherwise-clean
 * refactor: turning the sidebar into a column flex container silently gave
 * every child `flex-shrink: 1`, so once the open groups exceeded the
 * viewport the browser compressed all of them instead of scrolling. With
 * `.section--group { overflow: hidden }` on top, the closed groups collapsed
 * to a sliver, their headers were clipped, and the toggle buttons lost
 * nearly all of their hit area -- the sidebar looked fine and was unusable.
 *
 * jsdom does no layout, so an actual rendering assertion is not available
 * here; this is the strongest check the environment supports.
 */

const APP_CSS = readFileSync(resolve(__dirname, '../../src/App.css'), 'utf8')
const PRIMITIVES_CSS = readFileSync(resolve(__dirname, '../../src/ui/primitives/primitives.css'), 'utf8')

/** Returns the declaration body of the first rule matching `selector`. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+') // tolerate reformatting of `>` combinators
  const m = css.match(new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  if (!m) throw new Error(`rule not found: ${selector}`)
  return m[2]
}

describe('sidebar scrolls instead of compressing its groups', () => {
  it('the sidebar is the scroll container', () => {
    expect(ruleBody(APP_CSS, '.app-layout__sidebar')).toMatch(/overflow-y:\s*auto/)
  })

  it('sidebar children are pinned to their natural height', () => {
    // Without this the overflow-y above never engages: the children shrink
    // to fit instead, which is what made the task groups unclickable.
    const body = ruleBody(APP_CSS, '.app-layout__sidebar > *')
    expect(body).toMatch(/flex:\s*0\s+0\s+auto|flex-shrink:\s*0/)
  })
})

describe('sidebar header row does not clip the mode switch', () => {
  it('the pinned row wraps', () => {
    expect(ruleBody(APP_CSS, '.app-layout__sidebar-pinned-row')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('the mode switch never shrinks below its labels', () => {
    // .segmented sets `overflow: hidden` (to keep the active option's
    // background inside the rounded border), so a shrinkable mode switch
    // cuts the second label mid-glyph rather than showing an ellipsis.
    const body = ruleBody(APP_CSS, '.app-layout__sidebar-pinned-row .mode-switch')
    const shrink = body.match(/flex:\s*\d+\s+(\d+)\s+/)
    expect(shrink, `expected a three-value flex shorthand, got: ${body.trim()}`).not.toBeNull()
    expect(shrink![1], 'flex-shrink must be 0').toBe('0')
  })

  it('.segmented still relies on overflow hidden', () => {
    // If this ever stops being true the guard above is no longer needed --
    // fail loudly rather than leave a rule nobody can explain.
    expect(ruleBody(PRIMITIVES_CSS, '.segmented')).toMatch(/overflow:\s*hidden/)
  })
})

describe('the form-control reset loses to the primitives built on it', () => {
  /*
   * This project has now been bitten twice by the same thing: a container-
   * scoped element rule like `.app-layout__sidebar button` scores (0,1,1)
   * and quietly outranks `.btn` (0,1,0), so the reset's `font: inherit`
   * (16px) and `background` won over the Button primitive's own. It showed
   * up as export button labels being larger than the text around them and
   * wrapping onto two lines, and it silently overrode `background:
   * transparent` on the section toggles and icon buttons too.
   *
   * `:where()` keeps the scoping while contributing zero specificity. If
   * someone unwraps it to "make the selector clearer", the primitives start
   * losing again, in ways that look like unrelated visual bugs.
   */
  it('no button reset selector raises specificity with a bare container class', () => {
    // Asserting the absence of the bare form is what actually catches a
    // regression; asserting the presence of `:where(` alone would still pass
    // if someone *added* an unwrapped duplicate alongside it.
    const bare = PRIMITIVES_CSS.split('\n').filter((l) => /^\s*\.[\w-]+ button[^{]*[,{]\s*$/.test(l))
    expect(bare, `these selectors outrank .btn -- wrap the scope in :where():\n${bare.join('\n')}`).toEqual([])
  })

  it('the reset is still scoped (not a bare global `button` rule)', () => {
    // The `:where()` must keep the container list -- dropping it entirely
    // would leak this reset onto MapLibre's and Cesium's own widget buttons.
    expect(PRIMITIVES_CSS).toMatch(/:where\(\.app-layout__sidebar, \.perf-modal, \.map-cp-form\) button \{/)
  })
})

describe('collapsible section headers are a full-width hit target', () => {
  it('the toggle fills its header row', () => {
    expect(ruleBody(PRIMITIVES_CSS, '.section__toggle')).toMatch(/flex:\s*1\s+1\s+auto/)
  })
})
