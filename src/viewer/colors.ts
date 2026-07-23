import type { RGB } from '../labels/types.ts'

/**
 * Deterministic, well-separated colours for label tables that ship without any.
 *
 * Golden-angle rotation through hue with alternating lightness/saturation, so
 * that neighbouring label values — which in most atlases are anatomically
 * adjacent, or left/right pairs — never land on similar colours.
 */
export function synthesiseColor(ordinal: number): RGB {
  const hue = (ordinal * 137.508) % 360
  const sat = 0.55 + 0.25 * ((ordinal >> 1) % 2)
  const light = 0.45 + 0.16 * (ordinal % 3)
  return hslToRgb(hue / 360, sat, light)
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, h) * 255),
    Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  ]
}

function hueToChannel(p: number, q: number, t: number): number {
  let x = t
  if (x < 0) x += 1
  if (x > 1) x -= 1
  if (x < 1 / 6) return p + (q - p) * 6 * x
  if (x < 1 / 2) return q
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
  return p
}

export function rgbToHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [128, 128, 128]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
