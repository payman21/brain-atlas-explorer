import type { Region } from '../labels/types.ts'
import { hexToRgb, rgbToHex } from '../viewer/colors.ts'

export interface RegionListHandlers {
  onToggle: (value: number) => void
  onRecolor: (value: number, hex: string) => void
  onJump: (value: number) => void
}

/**
 * Flat list of regions with a checkbox, colour swatch and voxel count.
 *
 * Rebuilt wholesale on every change: a few hundred rows is well inside what the
 * DOM handles comfortably, and it keeps the selection logic in one place.
 */
export class RegionList {
  private readonly host: HTMLElement
  private readonly handlers: RegionListHandlers

  constructor(host: HTMLElement, handlers: RegionListHandlers) {
    this.host = host
    this.handlers = handlers
  }

  /**
   * `scalarOf`, when given, switches the row to heatmap mode: the meta column
   * shows the region's value and the colour swatch becomes a read-only chip,
   * since per-region recolour has no meaning while a heatmap drives the colours.
   */
  render(
    regions: Region[],
    selected: Set<number>,
    size: (value: number) => RegionSize,
    scalarOf?: (value: number) => number | undefined,
  ): void {
    this.scalarActive = scalarOf !== undefined
    if (regions.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'empty-list'
      empty.textContent = 'No regions match this search.'
      this.host.replaceChildren(empty)
      return
    }
    this.host.replaceChildren(
      ...regions.map((r) => this.row(r, selected.has(r.value), size(r.value), scalarOf?.(r.value))),
    )
  }

  private row(region: Region, isSelected: boolean, size: RegionSize, scalar: number | undefined): HTMLElement {
    const li = document.createElement('li')
    li.className = isSelected ? 'region selected' : 'region'
    const heatmapMode = this.scalarActive

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = isSelected
    check.addEventListener('change', (e) => {
      e.stopPropagation()
      this.handlers.onToggle(region.value)
    })

    let swatch: HTMLElement
    if (heatmapMode) {
      swatch = document.createElement('span')
      swatch.className = 'scalar-swatch'
      swatch.style.background = rgbToHex(region.color)
    } else {
      const picker = document.createElement('input')
      picker.type = 'color'
      picker.value = rgbToHex(region.color)
      picker.title = 'Region colour'
      picker.addEventListener('click', (e) => e.stopPropagation())
      picker.addEventListener('input', () => this.handlers.onRecolor(region.value, picker.value))
      swatch = picker
    }

    const absent = size.total === 0
    const name = document.createElement('span')
    name.className = absent ? 'region-name absent' : 'region-name'
    name.textContent = region.abbreviation ? `${region.name} (${region.abbreviation})` : region.name
    name.title = absent ? `${region.name} — nothing in the scene carries this label value` : region.name

    const meta = document.createElement('span')
    meta.className = 'region-meta'
    if (this.scalarActive) {
      meta.textContent = scalar === undefined ? '#' + region.value + ' · —' : `#${region.value} · ${formatScalar(scalar)}`
    } else {
      meta.textContent = `#${region.value} · ${describeSize(size)}`
    }

    // Clicking the row body centres the view on the region.
    li.addEventListener('click', () => this.handlers.onJump(region.value))
    li.append(check, swatch, name, meta)
    return li
  }

  /** True while a value file is loaded, so rows show values not sizes. */
  private scalarActive = false
}

export { hexToRgb }

/** How much of the scene a region occupies, split by representation. */
export interface RegionSize {
  voxels: number
  vertices: number
  total: number
}

/**
 * Voxels and vertices are different units, so they are labelled rather than
 * summed in the display — "2.1k vx" and "2.1k vt" mean very different things.
 */
function describeSize(size: RegionSize): string {
  if (size.total === 0) return '—'
  const parts: string[] = []
  if (size.voxels > 0) parts.push(`${formatCount(size.voxels)} vx`)
  if (size.vertices > 0) parts.push(`${formatCount(size.vertices)} vt`)
  return parts.join(' + ')
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Compact value display: a few significant figures without runaway decimals. */
export function formatScalar(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs !== 0 && (abs < 0.001 || abs >= 1e5)) return v.toExponential(2)
  return Number(v.toPrecision(4)).toString()
}
