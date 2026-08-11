import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../state/appStore'
import type { Track } from '../core/model/track'
import { getHudTrackStats, computeHudReadout, formatHoverParts, type HudTrackStats } from '../ui/hudStats'
import { indexToX, xToIndex } from './profileRender'

const PADDING = { top: 12, right: 16, bottom: 24, left: 48 }

function pickDisplayTrack(tracks: Track[], activeTrackId: string | undefined): Track | undefined {
  if (activeTrackId) {
    const active = tracks.find((t) => t.id === activeTrackId)
    if (active) return active
  }
  return tracks[0]
}

function niceElevationTicks(min: number, max: number, count = 4): number[] {
  if (max <= min) return [min]
  const span = max - min
  const rawStep = span / count
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const norm = rawStep / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const first = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let v = first; v <= max + 1e-6; v += step) ticks.push(v)
  return ticks.length > 0 ? ticks : [min, max]
}

/** "Nice" step size (1/2/5 * 10^n) for laying out evenly spaced axis ticks
 * across [0, max] in roughly `count` steps. */
function niceStep(max: number, count = 4): number {
  if (max <= 0) return 1
  const rawStep = max / count
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const norm = rawStep / mag
  return (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
}

function draw(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  track: Track | undefined,
  stats: HudTrackStats | undefined,
  hoverIndex: number | undefined,
): void {
  const dpr = window.devicePixelRatio || 1
  const backingW = Math.max(1, Math.round(cssWidth * dpr))
  const backingH = Math.max(1, Math.round(cssHeight * dpr))
  if (canvas.width !== backingW) canvas.width = backingW
  if (canvas.height !== backingH) canvas.height = backingH

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const rootStyle = getComputedStyle(document.documentElement)
  const textColor = rootStyle.getPropertyValue('--text').trim() || '#6b6375'
  const borderColor = rootStyle.getPropertyValue('--border').trim() || '#e5e4e7'
  const accentColor = rootStyle.getPropertyValue('--accent').trim() || '#aa3bff'

  if (!track || !stats || !stats.profile) {
    ctx.fillStyle = textColor
    ctx.font = '13px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      track ? '该轨迹没有海拔数据' : '暂无轨迹',
      cssWidth / 2,
      cssHeight / 2,
    )
    return
  }
  const profile = stats.profile

  const plotX = PADDING.left
  const plotY = PADDING.top
  const plotW = Math.max(1, cssWidth - PADDING.left - PADDING.right)
  const plotH = Math.max(1, cssHeight - PADDING.top - PADDING.bottom)

  // Degenerate elevation range (all-NaN column collapsed to min=max=0, or a
  // genuinely flat track): give it a fixed 10m band so the line doesn't
  // collapse onto the axis.
  const hasRange = profile.maxEle > profile.minEle
  const eleMin = hasRange ? profile.minEle : profile.minEle - 5
  const eleMax = hasRange ? profile.maxEle : profile.maxEle + 5
  const eleSpan = eleMax - eleMin

  const distToX = (dist: number) => plotX + (profile.totalDist > 0 ? (dist / profile.totalDist) * plotW : 0)
  const eleToY = (ele: number) => plotY + plotH - ((ele - eleMin) / eleSpan) * plotH

  // Y axis ticks (elevation, metres)
  const ticks = niceElevationTicks(profile.minEle, profile.maxEle)
  ctx.strokeStyle = borderColor
  ctx.fillStyle = textColor
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1
  for (const tick of ticks) {
    const y = eleToY(tick)
    ctx.beginPath()
    ctx.moveTo(plotX, y)
    ctx.lineTo(plotX + plotW, y)
    ctx.globalAlpha = 0.4
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillText(`${Math.round(tick)}m`, plotX - 6, y)
  }

  // X axis ticks (distance, km)
  const totalKm = profile.totalDist / 1000
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  if (totalKm <= 0) {
    ctx.fillText('0km', plotX, plotY + plotH + 6)
  } else {
    const kmStep = niceStep(totalKm)
    for (let km = 0; km <= totalKm + 1e-6; km += kmStep) {
      const x = distToX(km * 1000)
      ctx.fillText(`${km.toFixed(km < 10 ? 1 : 0)}km`, x, plotY + plotH + 6)
    }
  }

  // Elevation polyline + gradient fill, skipping NaN gaps.
  const gradient = ctx.createLinearGradient(0, plotY, 0, plotY + plotH)
  gradient.addColorStop(0, `${accentColor}55`)
  gradient.addColorStop(1, `${accentColor}05`)

  let penDown = false
  ctx.beginPath()
  for (let i = 0; i < profile.dist.length; i++) {
    const e = profile.ele[i]
    const x = distToX(profile.dist[i])
    if (!Number.isFinite(e)) {
      penDown = false
      continue
    }
    const y = eleToY(e)
    if (!penDown) {
      ctx.moveTo(x, y)
      penDown = true
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.strokeStyle = accentColor
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Fill: redo as closed regions per finite run so NaN gaps don't smear fill
  // across the gap.
  let runStart = -1
  for (let i = 0; i <= profile.dist.length; i++) {
    const finite = i < profile.dist.length && Number.isFinite(profile.ele[i])
    if (finite && runStart === -1) {
      runStart = i
    } else if (!finite && runStart !== -1) {
      const runEnd = i - 1
      ctx.beginPath()
      ctx.moveTo(distToX(profile.dist[runStart]), plotY + plotH)
      for (let j = runStart; j <= runEnd; j++) ctx.lineTo(distToX(profile.dist[j]), eleToY(profile.ele[j]))
      ctx.lineTo(distToX(profile.dist[runEnd]), plotY + plotH)
      ctx.closePath()
      ctx.fillStyle = gradient
      ctx.fill()
      runStart = -1
    }
  }

  // Axes frame
  ctx.strokeStyle = borderColor
  ctx.globalAlpha = 0.6
  ctx.beginPath()
  ctx.moveTo(plotX, plotY + plotH)
  ctx.lineTo(plotX + plotW, plotY + plotH)
  ctx.stroke()
  ctx.globalAlpha = 1

  // Hover cursor + readout
  if (hoverIndex != null) {
    const x = indexToX(track, profile, hoverIndex, plotW) + plotX
    ctx.strokeStyle = accentColor
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, plotY)
    ctx.lineTo(x, plotY + plotH)
    ctx.stroke()

    // Same HudReadout (mileage/elevation/ascent/gradient) computeHudReadout
    // feeds the flythrough HUD and the map's hover popup -- see this file's
    // own import comment and hudStats.ts#formatHoverParts's doc comment for
    // why this is the single source of truth those three places share.
    const readout = computeHudReadout(track, stats, hoverIndex)
    const label = formatHoverParts(readout).join(' · ')

    ctx.font = '12px system-ui, sans-serif'
    const textW = ctx.measureText(label).width
    const boxPad = 6
    let boxX = x + 8
    if (boxX + textW + boxPad * 2 > cssWidth) boxX = x - textW - boxPad * 2 - 8
    const boxY = plotY + 4

    ctx.fillStyle = rootStyle.getPropertyValue('--bg').trim() || '#fff'
    ctx.globalAlpha = 0.9
    ctx.fillRect(boxX, boxY, textW + boxPad * 2, 20)
    ctx.globalAlpha = 1
    ctx.strokeStyle = borderColor
    ctx.strokeRect(boxX, boxY, textW + boxPad * 2, 20)
    ctx.fillStyle = textColor
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, boxX + boxPad, boxY + 10)
  }
}

export function ProfileCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef({ width: 0, height: 0 })

  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const hover = useAppStore((s) => s.hover)
  const setHover = useAppStore((s) => s.setHover)
  const statsOptions = useAppStore((s) => s.statsOptions)

  const track = useMemo(() => pickDisplayTrack(tracks, activeTrackId), [tracks, activeTrackId])
  // Same cached (Track, statsOptions) -> HudTrackStats the flythrough HUD and
  // the map's hover popup read from (src/ui/hudStats.ts) -- this is also
  // where `profile` (below) now comes from, rather than a second
  // `buildProfileData` call, so the chart and the hover readout are built
  // from literally the same decimated arrays the other two hover-linked
  // views use.
  const stats = useMemo(() => (track ? getHudTrackStats(track, statsOptions) : undefined), [track, statsOptions])
  const profile = stats?.profile

  const hoverIndex = hover && track && hover.trackId === track.id ? hover.index : undefined

  // Refs mirroring latest data for the mouse handlers (registered once) and
  // the resize observer, so neither needs to be re-subscribed on every
  // render — same pattern MapView uses for its map-level listeners.
  const trackRef = useRef(track)
  trackRef.current = track
  const statsRef = useRef(stats)
  statsRef.current = stats
  const profileRef = useRef(profile)
  profileRef.current = profile
  const setHoverRef = useRef(setHover)
  setHoverRef.current = setHover

  const redraw = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { width, height } = sizeRef.current
    if (width <= 0 || height <= 0) return
    draw(canvas, width, height, trackRef.current, statsRef.current, hoverIndex)
  }
  const redrawRef = useRef(redraw)
  redrawRef.current = redraw

  // Redraw whenever the data to display or the hover cursor changes.
  useEffect(() => {
    redrawRef.current()
  }, [track, stats, hoverIndex])

  // Size the canvas to its container and redraw on resize.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      sizeRef.current = { width, height }
      redrawRef.current()
    })
    ro.observe(container)
    const rect = container.getBoundingClientRect()
    sizeRef.current = { width: rect.width, height: rect.height }
    redrawRef.current()
    return () => ro.disconnect()
  }, [])

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const p = profileRef.current
    const t = trackRef.current
    if (!p || !t) return
    const rect = e.currentTarget.getBoundingClientRect()
    const plotW = Math.max(1, rect.width - PADDING.left - PADDING.right)
    const xInPlot = e.clientX - rect.left - PADDING.left
    const index = xToIndex(p, xInPlot, plotW)
    setHoverRef.current({ trackId: t.id, index })
  }
  const handleMouseLeave = () => {
    setHoverRef.current(undefined)
  }

  return (
    <div ref={containerRef} className="profile-canvas" style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  )
}
