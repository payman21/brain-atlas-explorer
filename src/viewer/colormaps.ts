import type { RGB } from '../labels/types.ts'

/**
 * Continuous colormaps for rendering per-region scalar values (activations,
 * hierarchy levels, gradients…) as a heatmap over the parcellation.
 *
 * Each map is a short list of evenly spaced RGB control points; `evaluate`
 * interpolates between them. Sequential maps run dark→bright for magnitudes
 * that start at zero; diverging maps run through a neutral midpoint for signed
 * values centred on zero.
 *
 * The values are the standard matplotlib control points, subsampled — enough
 * stops that linear interpolation is visually indistinguishable from the
 * originals at screen and print resolution.
 */

export type ColormapKind = 'sequential' | 'diverging'

export interface Colormap {
  key: string
  label: string
  kind: ColormapKind
  stops: RGB[]
}

const COLORMAPS: Colormap[] = [
  {
    key: 'viridis',
    label: 'Viridis',
    kind: 'sequential',
    stops: [
      [68, 1, 84],
      [72, 40, 120],
      [62, 74, 137],
      [49, 104, 142],
      [38, 130, 142],
      [31, 158, 137],
      [53, 183, 121],
      [110, 206, 88],
      [181, 222, 43],
      [253, 231, 37],
    ],
  },
  {
    key: 'magma',
    label: 'Magma',
    kind: 'sequential',
    stops: [
      [0, 0, 4],
      [28, 16, 68],
      [79, 18, 123],
      [129, 37, 129],
      [181, 54, 122],
      [229, 80, 100],
      [251, 135, 97],
      [254, 194, 135],
      [252, 253, 191],
    ],
  },
  {
    key: 'inferno',
    label: 'Inferno',
    kind: 'sequential',
    stops: [
      [0, 0, 4],
      [31, 12, 72],
      [85, 15, 109],
      [136, 34, 106],
      [186, 54, 85],
      [227, 89, 51],
      [249, 140, 10],
      [249, 201, 50],
      [252, 255, 164],
    ],
  },
  {
    key: 'plasma',
    label: 'Plasma',
    kind: 'sequential',
    stops: [
      [13, 8, 135],
      [84, 2, 163],
      [139, 10, 165],
      [185, 50, 137],
      [219, 92, 104],
      [244, 136, 73],
      [254, 188, 43],
      [240, 249, 33],
    ],
  },
  {
    key: 'cividis',
    label: 'Cividis (colour-blind safe)',
    kind: 'sequential',
    stops: [
      [0, 34, 78],
      [0, 55, 106],
      [61, 79, 108],
      [110, 104, 110],
      [155, 131, 106],
      [201, 161, 94],
      [246, 195, 74],
      [255, 234, 70],
    ],
  },
  {
    key: 'rdbu',
    label: 'Red–Blue (diverging)',
    kind: 'diverging',
    stops: [
      [5, 48, 97],
      [33, 102, 172],
      [67, 147, 195],
      [146, 197, 222],
      [209, 229, 240],
      [247, 247, 247],
      [253, 219, 199],
      [244, 165, 130],
      [214, 96, 77],
      [178, 24, 43],
      [103, 0, 31],
    ],
  },
  {
    key: 'coolwarm',
    label: 'Cool–Warm (diverging)',
    kind: 'diverging',
    stops: [
      [59, 76, 192],
      [98, 130, 234],
      [141, 176, 254],
      [184, 208, 249],
      [221, 221, 221],
      [246, 193, 165],
      [244, 154, 123],
      [222, 96, 77],
      [180, 4, 38],
    ],
  },
  {
    key: 'rdylbu',
    label: 'Red–Yellow–Blue (diverging)',
    kind: 'diverging',
    stops: [
      [49, 54, 149],
      [69, 117, 180],
      [116, 173, 209],
      [171, 217, 233],
      [224, 243, 248],
      [255, 255, 191],
      [254, 224, 144],
      [253, 174, 97],
      [244, 109, 67],
      [215, 48, 39],
      [165, 0, 38],
    ],
  },
]

const BY_KEY = new Map(COLORMAPS.map((c) => [c.key, c]))

export function listColormaps(): Colormap[] {
  return COLORMAPS
}

export function getColormap(key: string): Colormap {
  return BY_KEY.get(key) ?? COLORMAPS[0]
}

/**
 * Colour at position `t` in [0, 1], clamped and linearly interpolated.
 *
 * `reversed` flips the map end for end — a Red–Blue diverging map becomes
 * Blue–Red, and any sequential map runs bright→dark — without needing a second
 * copy of the stops.
 */
export function evaluate(colormap: Colormap, t: number, reversed = false): RGB {
  const stops = colormap.stops
  const oriented = reversed ? 1 - t : t
  const clamped = oriented <= 0 ? 0 : oriented >= 1 ? 1 : oriented
  const scaled = clamped * (stops.length - 1)
  const i = Math.floor(scaled)
  if (i >= stops.length - 1) return stops[stops.length - 1]

  const frac = scaled - i
  const a = stops[i]
  const b = stops[i + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ]
}

/** A CSS `linear-gradient(...)` body for rendering the colourbar. */
export function cssGradient(colormap: Colormap, reversed = false): string {
  const stops = reversed ? [...colormap.stops].reverse() : colormap.stops
  return stops
    .map((c, i) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${((i / (stops.length - 1)) * 100).toFixed(1)}%`)
    .join(', ')
}
