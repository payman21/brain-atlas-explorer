import type { RGB } from '../labels/types.ts'

/**
 * A colourbar to draw into an exported figure, so the image explains its own
 * heatmap without the surrounding UI. The stops are already oriented (any
 * reverse applied), and mid is normally (min + max) / 2 — zero for a symmetric
 * diverging map.
 */
export interface Legend {
  stops: RGB[]
  min: number
  mid: number
  max: number
  title: string
  /** Contrast target: light text on a dark sheet, dark text on a light one. */
  dark: boolean
}

/** Height in pixels the legend needs beneath a figure `width` px wide. */
export function legendHeight(width: number): number {
  return Math.round(clamp(width * 0.09, 54, 150))
}

/**
 * Draw the colourbar into `[x, y, width, height]`: a title, a gradient band,
 * and min / mid / max ticks. Sizes scale with the band so it looks the same at
 * any export resolution.
 */
export function drawLegend(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  legend: Legend,
): void {
  const ink = legend.dark ? '#e6e9f0' : '#1a1e29'
  const faint = legend.dark ? 'rgba(230,233,240,0.55)' : 'rgba(26,30,41,0.55)'
  const font = Math.round(clamp(height * 0.2, 11, 34))

  const barWidth = Math.round(width * 0.6)
  const barHeight = Math.round(clamp(height * 0.28, 10, 46))
  const barX = Math.round(x + (width - barWidth) / 2)
  const titleY = Math.round(y + height * 0.18)
  const barY = Math.round(y + height * 0.34)
  const tickY = barY + barHeight + Math.round(font * 1.15)

  ctx.textBaseline = 'middle'

  if (legend.title) {
    ctx.fillStyle = faint
    ctx.font = `${Math.round(font * 0.9)}px ui-sans-serif, system-ui, -apple-system, Helvetica, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(legend.title, x + width / 2, titleY, width * 0.9)
  }

  // Gradient band.
  const gradient = ctx.createLinearGradient(barX, 0, barX + barWidth, 0)
  const n = legend.stops.length - 1
  legend.stops.forEach((c, i) => gradient.addColorStop(n === 0 ? 0 : i / n, `rgb(${c[0]}, ${c[1]}, ${c[2]})`))
  ctx.fillStyle = gradient
  ctx.fillRect(barX, barY, barWidth, barHeight)
  ctx.strokeStyle = faint
  ctx.lineWidth = Math.max(1, Math.round(font * 0.06))
  ctx.strokeRect(barX, barY, barWidth, barHeight)

  // Ticks.
  ctx.fillStyle = ink
  ctx.font = `${font}px ui-sans-serif, system-ui, -apple-system, Helvetica, sans-serif`
  ctx.textAlign = 'left'
  ctx.fillText(format(legend.min), barX, tickY)
  ctx.textAlign = 'center'
  ctx.fillText(format(legend.mid), barX + barWidth / 2, tickY)
  ctx.textAlign = 'right'
  ctx.fillText(format(legend.max), barX + barWidth, tickY)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Compact number for tick labels — a few significant figures, no long tails. */
function format(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs !== 0 && (abs < 0.001 || abs >= 1e5)) return v.toExponential(2)
  return Number(v.toPrecision(4)).toString()
}
