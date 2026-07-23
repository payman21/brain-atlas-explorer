import type { Region } from '../labels/types.ts'

export class ValueParseError extends Error {}

/** A parsed row from a value file, before it is matched to a region. */
interface ValueRow {
  /** Raw key text, or null for a single-column file. */
  key: string | null
  value: number
}

/** Per-region scalar values matched to a loaded parcellation. */
export interface ScalarField {
  name: string
  /** region label value (pre-offset) → scalar. */
  values: Map<number, number>
  dataMin: number
  dataMax: number
  /** How the file's rows were matched to regions, for the UI. */
  matchedBy: 'name' | 'index' | 'order'
  /** Region names/keys in the file that matched nothing. */
  unmatched: string[]
  /** Count of atlas regions left without a value. */
  missing: number
}

const NAME_KEYS = ['name', 'region', 'label', 'roi', 'structure', 'parcel', 'area']
const INDEX_KEYS = ['index', 'value', 'id', 'label_id', 'labelid', 'roi_id', 'node']
const VALUE_KEYS = ['scalar', 'weight', 'activation', 'stat', 'statistic', 't', 'z', 'beta', 'measure', 'data']

/**
 * Match a value file to a parcellation's regions.
 *
 * Three file shapes are accepted, decided by inspection:
 *
 *  - **name-keyed**: a name column and a value column. Matched case- and
 *    punctuation-insensitively against region names.
 *  - **index-keyed**: a numeric key column and a value column. Matched against
 *    region label values.
 *  - **single column**: one value per line, assigned to regions in ascending
 *    label-value order. Convenient, but positional, so it always warns.
 */
export function parseValues(filename: string, text: string, regions: Region[]): ScalarField {
  const delimiter = detectDelimiter(text)
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'))

  if (lines.length === 0) throw new ValueParseError('File is empty.')

  const { rows, matchedBy: keyKind } = readRows(lines, delimiter)
  if (rows.length === 0) throw new ValueParseError('No numeric values found.')

  const field = keyKind === 'order' ? matchByOrder(rows, regions) : matchByKey(rows, regions, keyKind)
  field.name = filename
  return field
}

// -------------------------------------------------------------- reading

function detectDelimiter(text: string): RegExp {
  const sample = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? ''
  if (sample.includes('\t')) return /\t/
  if (sample.includes(',')) return /,/
  return /\s+/
}

function readRows(lines: string[], delimiter: RegExp): { rows: ValueRow[]; matchedBy: 'name' | 'index' | 'order' } {
  const cells = lines.map((l) => l.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, '')))
  const width = Math.max(...cells.map((c) => c.length))

  if (width === 1) {
    const rows = cells
      .map((c) => Number(c[0]))
      .filter(Number.isFinite)
      .map((value) => ({ key: null, value }))
    return { rows, matchedBy: 'order' }
  }

  // Locate the value column and key column, honouring a header row if present.
  const header = cells[0].map((h) => h.toLowerCase())
  const hasHeader = cells[0].every((c) => !isNumeric(c)) || header.some((h) => VALUE_KEYS.includes(h) || NAME_KEYS.includes(h))

  let keyCol = header.findIndex((h) => NAME_KEYS.includes(h) || INDEX_KEYS.includes(h))
  let valueCol = header.findIndex((h) => VALUE_KEYS.includes(h))

  const body = hasHeader ? cells.slice(1) : cells
  if (keyCol < 0 || valueCol < 0) {
    // No usable header: assume first column is the key, last numeric column the value.
    keyCol = 0
    valueCol = lastNumericColumn(body, width)
    if (valueCol === keyCol) valueCol = width - 1
  }

  const keysNumeric = body.every((c) => isNumeric(c[keyCol] ?? ''))
  const rows: ValueRow[] = []
  for (const c of body) {
    const value = Number(c[valueCol])
    if (!Number.isFinite(value)) continue
    rows.push({ key: (c[keyCol] ?? '').trim(), value })
  }
  return { rows, matchedBy: keysNumeric ? 'index' : 'name' }
}

function lastNumericColumn(body: string[][], width: number): number {
  for (let col = width - 1; col >= 0; col--) {
    if (body.every((c) => isNumeric(c[col] ?? ''))) return col
  }
  return width - 1
}

function isNumeric(text: string): boolean {
  return text !== '' && Number.isFinite(Number(text))
}

// -------------------------------------------------------------- matching

function matchByKey(rows: ValueRow[], regions: Region[], kind: 'name' | 'index'): ScalarField {
  const values = new Map<number, number>()
  const unmatched: string[] = []

  const byName = new Map<string, number>()
  const byIndex = new Map<number, number>()
  for (const r of regions) {
    byName.set(normalise(r.name), r.value)
    if (r.abbreviation) byName.set(normalise(r.abbreviation), r.value)
    byIndex.set(r.value, r.value)
  }

  for (const row of rows) {
    const key = row.key ?? ''
    let regionValue: number | undefined
    if (kind === 'index') regionValue = byIndex.get(Number(key))
    else regionValue = byName.get(normalise(key))

    if (regionValue === undefined) unmatched.push(key)
    else values.set(regionValue, row.value)
  }

  return finalise(values, unmatched, regions.length, kind)
}

function matchByOrder(rows: ValueRow[], regions: Region[]): ScalarField {
  const ordered = [...regions].sort((a, b) => a.value - b.value)
  const values = new Map<number, number>()
  const n = Math.min(rows.length, ordered.length)
  for (let i = 0; i < n; i++) values.set(ordered[i].value, rows[i].value)

  const unmatched = rows.length > ordered.length ? [`${rows.length - ordered.length} extra values`] : []
  return finalise(values, unmatched, regions.length, 'order')
}

function finalise(
  values: Map<number, number>,
  unmatched: string[],
  regionCount: number,
  matchedBy: ScalarField['matchedBy'],
): ScalarField {
  if (values.size === 0) {
    throw new ValueParseError('No values could be matched to regions in the loaded parcellation.')
  }
  let dataMin = Infinity
  let dataMax = -Infinity
  for (const v of values.values()) {
    if (v < dataMin) dataMin = v
    if (v > dataMax) dataMax = v
  }
  return {
    name: '',
    values,
    dataMin,
    dataMax,
    matchedBy,
    unmatched,
    missing: regionCount - values.size,
  }
}

/** Case- and punctuation-insensitive key for name matching. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}
