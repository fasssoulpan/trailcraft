import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * Static audit of the design token layer (src/index.css).
 *
 * Why static rather than "open it and look": the visual redesign is the one
 * part of this project that cannot be checked in the sandboxed preview --
 * that pane does not composite frames, and its CSSOM readings proved
 * actively wrong (an inline literal background reported back as the *other*
 * theme's value, and `documentElement.matches(":root[data-theme='light']")`
 * returned false while the attribute was demonstrably 'light'). Measuring
 * contrast through it produced five "failures" that were all artefacts.
 *
 * So the contrast maths is done here instead, from the token definitions on
 * disk, where it is deterministic and cannot rot silently. This does NOT
 * claim the app looks good -- that still needs a human. It claims the
 * palette is legible in both themes, which is the part a machine can own.
 */

const CSS = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8')
const CAPTURE_DRAW = readFileSync(resolve(__dirname, '../../src/overlay/captureDraw.ts'), 'utf8')

/** Pulls the `--token: value;` pairs out of one top-level rule block. */
function tokensOf(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector)
  if (start < 0) throw new Error(`selector not found in index.css: ${selector}`)
  const open = CSS.indexOf('{', start)
  // Nested blocks exist (`:root` contains an @media), so match braces rather
  // than scanning to the first '}'.
  let depth = 0
  let end = open
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = CSS.slice(open + 1, end)
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

type Rgb = [number, number, number]

function toRgb(value: string, backdrop: Rgb): Rgb {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1]
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/)
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => parseFloat(p.trim()))
    const [r, g, b] = parts
    const a = parts.length > 3 ? parts[3] : 1
    // Composite over the backdrop so translucent chrome is judged as seen.
    return [r, g, b].map((c, i) => Math.round(c * a + backdrop[i] * (1 - a))) as Rgb
  }
  throw new Error(`unparseable colour: ${value}`)
}

function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

const DARK = tokensOf(':root {')
const LIGHT = tokensOf(":root[data-theme='light']")
const AUTO_LIGHT = tokensOf(':root:not([data-theme])')

/** Text pairs that must clear WCAG AA for body copy. */
const BODY_PAIRS: Array<[fg: string, bg: string]> = [
  ['--color-text', '--color-bg'],
  ['--color-text', '--color-surface'],
  ['--color-text', '--color-surface-raised'],
  ['--color-text-muted', '--color-bg'],
  ['--color-text-muted', '--color-surface'],
  ['--color-text-muted', '--color-surface-raised'],
  ['--color-primary-contrast', '--color-primary'],
]

/*
 * Status/accent colours carry meaning through hue and are used on badges,
 * short labels and bar fills rather than paragraphs, so they are held to the
 * 3:1 non-text/large-text threshold rather than 4.5:1. Holding a warning
 * amber to 4.5:1 on a light surface forces it so dark it stops reading as
 * amber, which trades one legibility problem for a worse one.
 */
const ACCENT_PAIRS: Array<[fg: string, bg: string]> = [
  ['--color-primary', '--color-surface'],
  ['--color-success', '--color-surface'],
  ['--color-warning', '--color-surface'],
  ['--color-danger', '--color-surface'],
  ['--color-info', '--color-surface'],
]

describe('design token contrast', () => {
  for (const [themeName, theme] of [
    ['dark', DARK],
    ['light', { ...DARK, ...LIGHT }],
  ] as const) {
    const bgOf = (name: string): Rgb => toRgb(theme[name], [0, 0, 0])

    for (const [fg, bg] of BODY_PAIRS) {
      it(`${themeName}: ${fg} on ${bg} clears AA body text`, () => {
        const ratio = contrast(toRgb(theme[fg], bgOf(bg)), bgOf(bg))
        expect(ratio, `${fg} (${theme[fg]}) on ${bg} (${theme[bg]}) = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
      })
    }

    for (const [fg, bg] of ACCENT_PAIRS) {
      it(`${themeName}: ${fg} on ${bg} clears 3:1`, () => {
        const ratio = contrast(toRgb(theme[fg], bgOf(bg)), bgOf(bg))
        expect(ratio, `${fg} (${theme[fg]}) on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
      })
    }
  }

  /*
   * Overlay chrome is deliberately theme-invariant (it floats over dark
   * satellite imagery in both themes), so it is checked once, against its
   * own darkest backdrop rather than against --color-bg.
   */
  it('overlay chrome is legible over the globe in either theme', () => {
    const canvas = toRgb(DARK['--overlay-canvas-bg'], [0, 0, 0])
    const pairs: Array<[string, string, number]> = [
      ['--overlay-text', '--overlay-bg', 4.5],
      ['--overlay-text-strong', '--overlay-bg-card', 4.5],
      ['--overlay-text-muted', '--overlay-bg-card', 4.5],
      ['--overlay-text-muted', '--overlay-bg-soft', 4.5],
      ['--overlay-text-dim', '--overlay-bg', 3],
      ['--overlay-danger', '--overlay-bg-card', 3],
      ['--overlay-accent', '--overlay-bg', 3],
      ['--overlay-accent-contrast', '--overlay-accent', 4.5],
    ]
    for (const [fg, bg, min] of pairs) {
      const backdrop = toRgb(DARK[bg], canvas)
      const ratio = contrast(toRgb(DARK[fg], backdrop), backdrop)
      expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1 (need ${min})`).toBeGreaterThanOrEqual(min)
    }
  })
})

describe('design token completeness', () => {
  /*
   * A colour token added to the dark block but forgotten in the light block
   * does not fail loudly -- it silently keeps the dark value, which is how
   * you end up with near-invisible text on one theme only. Structural, and
   * exactly the failure this file exists to prevent.
   */
  it('the light theme redefines every themed colour role', () => {
    const themed = Object.keys(DARK).filter(
      (k) => k.startsWith('--color-') && !k.startsWith('--overlay-'),
    )
    const missing = themed.filter((k) => !(k in LIGHT))
    expect(missing, `light theme is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('overlay tokens are NOT theme-flipped', () => {
    // Flipping these would desync the on-screen preview from the exported
    // video (see captureDraw.ts) -- the constraint is load-bearing, not taste.
    const flipped = Object.keys(LIGHT).filter((k) => k.startsWith('--overlay-'))
    expect(flipped, `overlay tokens must not be redefined per-theme: ${flipped.join(', ')}`).toEqual([])
  })

  it('the prefers-color-scheme fallback matches the explicit light theme', () => {
    // These two blocks are duplicated out of necessity (one keys off an
    // attribute, one off a media query). Duplication drifts; assert it can't.
    for (const [name, value] of Object.entries(LIGHT)) {
      expect(AUTO_LIGHT[name], `--${name} differs between the light theme and its media-query twin`).toBe(value)
    }
  })
})

describe('exported video overlay matches the on-screen overlay', () => {
  /*
   * captureDraw.ts repaints the HUD and checkpoint card onto the export
   * canvas. A canvas 2D context cannot read CSS custom properties, so it
   * carries its own copies of these literals. The user composes a shot
   * against the live preview; if the two drift, the preview stops predicting
   * the MP4. Enforced here rather than left to a comment.
   */
  const TWINS: Array<[constant: string, token: string]> = [
    ['HUD_CHIP_BG', '--overlay-bg-soft'],
    ['HUD_LABEL_COLOR', '--overlay-text-muted'],
    ['HUD_VALUE_COLOR', '--overlay-text-strong'],
    ['CARD_BG', '--overlay-bg-card'],
    ['CARD_NAME_COLOR', '--overlay-text-strong'],
    ['CARD_META_COLOR', '--overlay-text-muted'],
    ['CARD_CUTOFF_COLOR', '--overlay-danger'],
  ]

  for (const [constant, token] of TWINS) {
    it(`${constant} equals ${token}`, () => {
      const m = CAPTURE_DRAW.match(new RegExp(`const ${constant} = '([^']+)'`))
      expect(m, `${constant} not found in captureDraw.ts`).not.toBeNull()
      const normalise = (s: string) => s.replace(/\s+/g, '').toLowerCase()
      expect(normalise(m![1])).toBe(normalise(DARK[token]))
    })
  }
})
