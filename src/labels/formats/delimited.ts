import { LabelParseError, type LabelTable, type RGB } from '../types.ts'
import { hexToRgb } from '../../viewer/colors.ts'

/**
 * BIDS `*_dseg.tsv` and its CSV cousins — the canonical format.
 *
 * Required columns: an index and a name, under any of the aliases below.
 * Colour is optional and may arrive as a `color` hex string or as separate
 * r/g/b columns.
 */

const INDEX_KEYS = ['index', 'value', 'id', 'voxel_value', 'label_id', 'labelid', 'intensity']
const NAME_KEYS = ['name', 'label_name', 'labelname', 'region', 'structure', 'label', 'roi']
const ABBREV_KEYS = ['abbreviation', 'abbrev', 'short_name', 'acronym']
const COLOR_KEYS = ['color', 'colour', 'hex', 'rgb']

export function parseDelimited(text: string, delimiter: string, formatName: string): LabelTable {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  if (rows.length < 2) throw new LabelParseError('Not enough rows for a table with a header.')

  const header = rows[0].split(delimiter).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const col = (keys: string[]) => header.findIndex((h) => keys.includes(h))

  const iIdx = col(INDEX_KEYS)
  const iName = col(NAME_KEYS)
  if (iIdx < 0 || iName < 0) {
    throw new LabelParseError(
      `Header needs an index column (${INDEX_KEYS.slice(0, 3).join('/')}) and a name column ` +
        `(${NAME_KEYS.slice(0, 3).join('/')}). Found: ${header.join(', ')}`,
    )
  }

  const iAbbrev = col(ABBREV_KEYS)
  const iColor = col(COLOR_KEYS)
  const iR = header.indexOf('r') >= 0 ? header.indexOf('r') : header.indexOf('red')
  const iG = header.indexOf('g') >= 0 ? header.indexOf('g') : header.indexOf('green')
  const iB = header.indexOf('b') >= 0 ? header.indexOf('b') : header.indexOf('blue')
  const hasRgbCols = iR >= 0 && iG >= 0 && iB >= 0

  const warnings: string[] = []
  const regions: LabelTable['regions'] = []

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''))
    const value = Number(cells[iIdx])
    if (!Number.isFinite(value)) {
      warnings.push(`Row ${r + 1}: index "${cells[iIdx]}" is not a number — skipped.`)
      continue
    }
    const name = cells[iName] ?? ''
    if (name === '') {
      warnings.push(`Row ${r + 1}: empty name — skipped.`)
      continue
    }

    let color: RGB | undefined
    if (iColor >= 0 && cells[iColor]) color = hexToRgb(cells[iColor])
    else if (hasRgbCols) {
      const rgb: RGB = [Number(cells[iR]), Number(cells[iG]), Number(cells[iB])]
      if (rgb.every(Number.isFinite)) color = rgb
    }

    regions.push({
      value,
      name,
      abbreviation: iAbbrev >= 0 ? cells[iAbbrev] || undefined : undefined,
      color: color ?? [128, 128, 128],
      colorSynthesised: color === undefined,
    })
  }

  if (regions.length === 0) throw new LabelParseError('No usable rows found.')
  return { regions, format: formatName, warnings }
}
