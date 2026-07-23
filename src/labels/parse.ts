import { LabelParseError, type LabelTable } from './types.ts'
import { parseDelimited } from './formats/delimited.ts'
import { looksLikeItkSnap, parseFreeSurferLut, parseItkSnap } from './formats/plainText.ts'
import { parseFslXml } from './formats/fslXml.ts'
import { parseJsonLabels } from './formats/json.ts'
import {
  looksLikeWorkbenchLabelList,
  parseNameList,
  parseWorkbenchLabelList,
} from './formats/workbench.ts'
import { synthesiseColor } from '../viewer/colors.ts'

/**
 * Pick an adapter by extension, then by content shape. Extensions are a weak
 * signal here — `.txt` covers two incompatible conventions and `.json` covers
 * three — so sniffing does the real work.
 */
export function parseLabelFile(filename: string, text: string): LabelTable {
  const lower = filename.toLowerCase()
  let table: LabelTable

  if (lower.endsWith('.json')) {
    table = parseJsonLabels(text)
  } else if (lower.endsWith('.xml')) {
    table = parseFslXml(text)
  } else if (lower.endsWith('.tsv')) {
    table = parseDelimited(text, '\t', 'BIDS dseg.tsv')
  } else if (lower.endsWith('.csv')) {
    table = parseDelimited(text, ',', 'CSV label table')
  } else {
    table = parseUnknownText(text)
  }

  return finalise(table)
}

/** `.txt`, `.lut`, `.label` and anything unrecognised: decide by shape. */
function parseUnknownText(text: string): LabelTable {
  if (text.trimStart().startsWith('<')) return parseFslXml(text)
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) return parseJsonLabels(text)
  if (looksLikeItkSnap(text)) return parseItkSnap(text)
  // Checked before the LUT reader: a Workbench list's name lines would
  // otherwise be misread as malformed LUT rows.
  if (looksLikeWorkbenchLabelList(text)) return parseWorkbenchLabelList(text)

  const firstLine = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? ''
  if (firstLine.includes('\t')) {
    try {
      return parseDelimited(text, '\t', 'tab-delimited label table')
    } catch {
      /* fall through to the LUT reader */
    }
  }

  try {
    return parseFreeSurferLut(text)
  } catch (err) {
    // Nothing structured matched. A bare list of names is the only remaining
    // convention worth guessing at, and it announces the guess.
    try {
      return parseNameList(text)
    } catch {
      throw err
    }
  }
}

/** Deduplicate, sort, and fill in any colours the source format did not carry. */
function finalise(table: LabelTable): LabelTable {
  const seen = new Map<number, string>()
  const regions = table.regions.filter((r) => {
    const prev = seen.get(r.value)
    if (prev !== undefined) {
      table.warnings.push(`Label value ${r.value} appears more than once ("${prev}", "${r.name}"); kept the first.`)
      return false
    }
    seen.set(r.value, r.name)
    return true
  })

  regions.sort((a, b) => a.value - b.value)
  regions.forEach((r, i) => {
    if (r.colorSynthesised) r.color = synthesiseColor(i)
  })

  if (regions.length === 0) throw new LabelParseError('Label table is empty after parsing.')
  return { ...table, regions }
}

export interface Reconciliation {
  /** Offset added to every label value to line the table up with the volume. */
  offset: number
  /** Fraction of the volume's non-zero label values the table names. */
  coverage: number
  /** Label values present in the volume but absent from the table. */
  unnamed: number[]
  /** Regions in the table that match no voxel in the volume. */
  empty: number
}

/**
 * Decide how the label table lines up with the values actually present in the
 * volume, and whether shifting by ±1 explains it better.
 *
 * This is the single most common ingestion failure — FSL's 0-based `index`,
 * and tables that do or do not count background — so it is worth resolving
 * from the data rather than asking the user to know.
 */
export function reconcileValues(table: LabelTable, volumeValues: Set<number>): Reconciliation {
  const score = (offset: number) => {
    let hit = 0
    for (const r of table.regions) if (volumeValues.has(r.value + offset)) hit++
    return hit
  }

  const candidates = [0, 1, -1].map((offset) => ({ offset, hit: score(offset) }))
  const best = candidates.reduce((a, b) => (b.hit > a.hit ? b : a))

  const named = new Set(table.regions.map((r) => r.value + best.offset))
  const unnamed = [...volumeValues].filter((v) => !named.has(v)).sort((a, b) => a - b)

  return {
    offset: best.offset,
    coverage: volumeValues.size === 0 ? 0 : (volumeValues.size - unnamed.length) / volumeValues.size,
    unnamed,
    empty: table.regions.length - best.hit,
  }
}
