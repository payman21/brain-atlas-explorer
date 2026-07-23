/**
 * Canonical internal representation of a parcellation's label table.
 *
 * Every supported input format is adapted into this shape. It is modelled on
 * BIDS `*_dseg.tsv` (index / name / color), which is the only format in the
 * zoo with an actual specification behind it.
 */

export type RGB = [number, number, number]

export interface Region {
  /** Voxel intensity in the parcellation volume. */
  value: number
  /** Human-readable region name, as given by the label table. */
  name: string
  /** Optional short form (BIDS `abbreviation`, FreeSurfer has none). */
  abbreviation?: string
  /** Display colour. Synthesised if the source format carries none. */
  color: RGB
  /** True when `color` was generated rather than read from the file. */
  colorSynthesised: boolean
}

export interface LabelTable {
  regions: Region[]
  /** Name of the format the adapter matched, for display. */
  format: string
  /**
   * Non-fatal problems worth showing the user: duplicate values, rows that
   * failed to parse, ambiguous value conventions.
   */
  warnings: string[]
}

export class LabelParseError extends Error {}
