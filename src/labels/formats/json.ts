import { LabelParseError, type LabelTable, type RGB, type Region } from '../types.ts'
import { hexToRgb } from '../../viewer/colors.ts'

/**
 * Three JSON shapes seen in the wild:
 *
 *  1. NiiVue / colour-table style, arrays parallel by position (or by `I`):
 *       { "R": [...], "G": [...], "B": [...], "I": [...], "labels": [...] }
 *  2. A plain value → name map:
 *       { "1": "Precentral_L", "2": "Precentral_R" }
 *  3. An array of records:
 *       [ { "index": 1, "name": "Precentral_L", "color": "#ff0000" } ]
 */
export function parseJsonLabels(text: string): LabelTable {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new LabelParseError(`Invalid JSON: ${(err as Error).message}`)
  }

  if (Array.isArray(data)) return fromRecords(data)
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.labels)) return fromColorTable(obj)
    if (Array.isArray(obj.regions)) return fromRecords(obj.regions)
    return fromValueMap(obj)
  }
  throw new LabelParseError('Unrecognised JSON structure for a label table.')
}

function fromColorTable(obj: Record<string, unknown>): LabelTable {
  const labels = obj.labels as unknown[]
  const R = numArray(obj.R)
  const G = numArray(obj.G)
  const B = numArray(obj.B)
  const I = numArray(obj.I)
  const hasColor = R.length >= labels.length && G.length >= labels.length && B.length >= labels.length

  const warnings: string[] = []
  if (!hasColor && (R.length || G.length || B.length)) {
    warnings.push('Colour arrays are shorter than the label list; colours were generated instead.')
  }

  const regions: Region[] = []
  for (let i = 0; i < labels.length; i++) {
    const name = String(labels[i] ?? '').trim()
    const value = I.length === labels.length ? I[i] : i
    // Position 0 is the background entry in this convention.
    if (value === 0 || name === '' || name === '?') continue
    regions.push({
      value,
      name,
      color: hasColor ? [R[i], G[i], B[i]] : [128, 128, 128],
      colorSynthesised: !hasColor,
    })
  }

  if (regions.length === 0) throw new LabelParseError('Colour table contained no named regions.')
  return { regions, format: 'JSON colour table', warnings }
}

function fromValueMap(obj: Record<string, unknown>): LabelTable {
  const regions: Region[] = []
  for (const [key, val] of Object.entries(obj)) {
    const value = Number(key)
    if (!Number.isFinite(value) || value === 0) continue
    const name = typeof val === 'string' ? val : String((val as Record<string, unknown>)?.name ?? '')
    if (name === '') continue
    regions.push({ value, name, color: [128, 128, 128], colorSynthesised: true })
  }
  if (regions.length === 0) throw new LabelParseError('JSON object held no value → name entries.')
  return { regions, format: 'JSON value map', warnings: [] }
}

function fromRecords(rows: unknown[]): LabelTable {
  const warnings: string[] = []
  const regions: Region[] = []

  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return
    const r = row as Record<string, unknown>
    const value = Number(r.index ?? r.value ?? r.id ?? r.label_id)
    const name = String(r.name ?? r.label ?? r.region ?? '').trim()
    if (!Number.isFinite(value) || name === '') {
      warnings.push(`Entry ${i}: needs a numeric index and a name — skipped.`)
      return
    }
    let color: RGB | undefined
    if (typeof r.color === 'string') color = hexToRgb(r.color)
    else if (Array.isArray(r.color) && r.color.length >= 3) color = numArray(r.color).slice(0, 3) as RGB
    else if (r.r !== undefined) {
      const rgb: RGB = [Number(r.r), Number(r.g), Number(r.b)]
      if (rgb.every(Number.isFinite)) color = rgb
    }
    regions.push({
      value,
      name,
      abbreviation: typeof r.abbreviation === 'string' ? r.abbreviation : undefined,
      color: color ?? [128, 128, 128],
      colorSynthesised: color === undefined,
    })
  })

  if (regions.length === 0) throw new LabelParseError('JSON array held no usable label records.')
  return { regions, format: 'JSON records', warnings }
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []
}
