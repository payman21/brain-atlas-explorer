import { LabelParseError, type LabelTable, type Region } from '../types.ts'

/**
 * Connectome Workbench label list, the input format for
 * `wb_command -cifti-label-import`. Records span two lines:
 *
 *   aHIP-rh
 *   1 144 246 45 255
 *   pHIP-rh
 *   2 34 165 59 255
 *
 * That is: a bare name, then `key R G B A`. Schaefer, Glasser, Tian and most
 * other HCP-lineage parcellations ship their labels this way, so it is worth
 * supporting even though the volumes themselves are often CIFTI.
 */

export function looksLikeWorkbenchLabelList(text: string): boolean {
  const lines = dataLines(text)
  if (lines.length < 4) return false

  // Expect strict alternation: non-numeric name, then a 5-number row.
  let pairs = 0
  for (let i = 0; i + 1 < Math.min(lines.length, 12); i += 2) {
    if (isNumericRow(lines[i])) return false
    if (!isNumericRow(lines[i + 1])) return false
    pairs++
  }
  return pairs >= 2
}

export function parseWorkbenchLabelList(text: string): LabelTable {
  const lines = dataLines(text)
  const warnings: string[] = []
  const regions: Region[] = []

  if (lines.length % 2 !== 0) {
    warnings.push('File has an odd number of lines; the final entry was incomplete and skipped.')
  }

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const name = lines[i]
    const fields = lines[i + 1].split(/\s+/)

    if (isNumericRow(name) || fields.length < 4) {
      warnings.push(`Line ${i + 1}: expected a name followed by "key R G B A" — skipped.`)
      continue
    }

    const value = Number(fields[0])
    if (!Number.isFinite(value)) {
      warnings.push(`Line ${i + 2}: "${fields[0]}" is not a label key — skipped.`)
      continue
    }
    if (value === 0) continue // "???" background entry

    const [r, g, b] = [Number(fields[1]), Number(fields[2]), Number(fields[3])]
    regions.push({
      value,
      name,
      color: [r, g, b].every(Number.isFinite) ? [r, g, b] : [128, 128, 128],
      colorSynthesised: false,
    })
  }

  if (regions.length === 0) throw new LabelParseError('No Workbench label records found.')
  return { regions, format: 'Connectome Workbench label list', warnings }
}

/**
 * Last-resort reader for a file that is nothing but names, one per line, where
 * position implies the label value (line 1 → value 1). Tian's
 * `*_label.txt` ships like this. Ambiguous by nature, so it always warns.
 */
export function parseNameList(text: string): LabelTable {
  const lines = dataLines(text)
  if (lines.length === 0) throw new LabelParseError('File is empty.')
  if (lines.some(isNumericRow)) {
    throw new LabelParseError('File mixes names and numeric rows; it is not a plain name list.')
  }

  const regions = lines.map((name, i) => ({
    value: i + 1,
    name,
    color: [128, 128, 128] as [number, number, number],
    colorSynthesised: true,
  }))

  return {
    regions,
    format: 'plain name list',
    warnings: [
      'This file holds names only, so label values were assumed to run 1…N in file order. ' +
        'Check a few regions against a known atlas before trusting the names.',
    ],
  }
}

function dataLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

function isNumericRow(line: string): boolean {
  const fields = line.split(/\s+/)
  return fields.length >= 2 && fields.every((f) => Number.isFinite(Number(f)))
}
