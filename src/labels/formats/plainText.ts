import { LabelParseError, type LabelTable, type Region } from '../types.ts'

/**
 * The two whitespace-delimited `.txt` conventions, which share an extension and
 * must be told apart by shape.
 *
 *   FreeSurfer LUT   `17  Left-Hippocampus  220 216 20 0`
 *                    6 fields, unquoted name in position 2.
 *
 *   ITK-SNAP         `  1  255 0 0  1 1 1  "Label 1"`
 *                    8 fields, quoted name last.
 */

export function looksLikeItkSnap(text: string): boolean {
  return firstDataLines(text).some((l) => /"[^"]*"\s*$/.test(l))
}

function firstDataLines(text: string, n = 20): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .slice(0, n)
}

export function parseItkSnap(text: string): LabelTable {
  const warnings: string[] = []
  const regions: Region[] = []

  for (const [i, line] of enumerateData(text)) {
    const m = /^\s*(-?\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+"(.*)"\s*$/.exec(line)
    if (!m) {
      warnings.push(`Line ${i}: does not match the ITK-SNAP column layout — skipped.`)
      continue
    }
    const value = Number(m[1])
    const name = m[8]
    // Index 0 is ITK-SNAP's mandatory "Clear Label" background entry.
    if (value === 0) continue
    regions.push({
      value,
      name,
      color: [Number(m[2]), Number(m[3]), Number(m[4])],
      colorSynthesised: false,
    })
  }

  if (regions.length === 0) throw new LabelParseError('No ITK-SNAP label rows found.')
  return { regions, format: 'ITK-SNAP label description', warnings }
}

export function parseFreeSurferLut(text: string): LabelTable {
  const warnings: string[] = []
  const regions: Region[] = []

  for (const [i, line] of enumerateData(text)) {
    const f = line.split(/\s+/)
    if (f.length < 5) {
      warnings.push(`Line ${i}: expected at least 5 fields — skipped.`)
      continue
    }
    const value = Number(f[0])
    if (!Number.isFinite(value)) {
      warnings.push(`Line ${i}: "${f[0]}" is not a label value — skipped.`)
      continue
    }
    if (value === 0) continue // "Unknown" background
    const [r, g, b] = [Number(f[2]), Number(f[3]), Number(f[4])]
    regions.push({
      value,
      name: f[1],
      // FreeSurfer writes alpha as 0 by convention; it does not mean transparent.
      color: [r, g, b].every(Number.isFinite) ? [r, g, b] : [128, 128, 128],
      colorSynthesised: false,
    })
  }

  if (regions.length === 0) throw new LabelParseError('No FreeSurfer LUT rows found.')
  return { regions, format: 'FreeSurfer colour LUT', warnings }
}

function* enumerateData(text: string): Generator<[number, string]> {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.length === 0 || line.startsWith('#')) continue
    yield [i + 1, line]
  }
}
