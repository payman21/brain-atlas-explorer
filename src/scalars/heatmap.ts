import type { Region, RGB } from '../labels/types.ts'
import type { ScalarField } from './values.ts'
import { evaluate, getColormap, type Colormap } from '../viewer/colormaps.ts'

/** Colour for regions that carry no scalar value, so the brain stays legible. */
export const NO_VALUE_COLOR: RGB = [70, 76, 88]

export interface Heatmap {
  colormap: Colormap
  /** Whether the colormap is flipped end for end. */
  reversed: boolean
  /** Active display domain. */
  min: number
  max: number
  /** Scalar → colour, clamped to the domain. */
  colorOf: (scalar: number) => RGB
}

/**
 * Build the mapping from scalar value to colour for the current settings.
 *
 * The domain defaults to the data's own range. A diverging colormap with
 * `symmetric` on is instead centred on zero and made symmetric about it, so the
 * neutral midpoint lands exactly at zero — the only way a red/blue split reads
 * as "sign of the value" rather than "above/below the mean".
 */
export function buildHeatmap(
  scalar: ScalarField,
  colormapKey: string,
  symmetric: boolean,
  range: { min: number; max: number } | null,
  reversed = false,
): Heatmap {
  const colormap = getColormap(colormapKey)

  let min: number
  let max: number
  if (range) {
    ;({ min, max } = range)
  } else if (colormap.kind === 'diverging' && symmetric) {
    const extent = Math.max(Math.abs(scalar.dataMin), Math.abs(scalar.dataMax)) || 1
    min = -extent
    max = extent
  } else {
    min = scalar.dataMin
    max = scalar.dataMax
  }

  const span = max - min || 1
  return {
    colormap,
    reversed,
    min,
    max,
    colorOf: (value) => evaluate(colormap, (value - min) / span, reversed),
  }
}

/**
 * Regions recoloured by their scalar value; regions without a value fall back
 * to a neutral grey. The categorical names and label values are untouched, so
 * search, selection and the region list keep working.
 */
export function heatmapRegions(regions: Region[], scalar: ScalarField, heatmap: Heatmap): Region[] {
  return regions.map((region) => {
    const value = scalar.values.get(region.value)
    return {
      ...region,
      color: value === undefined ? NO_VALUE_COLOR : heatmap.colorOf(value),
    }
  })
}

/** Whether a diverging colormap is the natural default for these data. */
export function suggestColormap(scalar: ScalarField): { colormap: string; symmetric: boolean } {
  const signed = scalar.dataMin < 0 && scalar.dataMax > 0
  return signed ? { colormap: 'rdbu', symmetric: true } : { colormap: 'viridis', symmetric: false }
}
