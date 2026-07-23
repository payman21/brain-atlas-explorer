import type { LabelTable, RGB } from './labels/types.ts'
import type { Reconciliation } from './labels/parse.ts'
import type { ScalarField } from './scalars/values.ts'

/** Which representations the current parcellation occupies. */
export type ViewMode = 'volume' | 'surface'

export interface AppState {
  table: LabelTable | null
  mode: ViewMode
  reconciliation: Reconciliation | null
  /** Offset applied to label values; starts at the reconciled value. */
  offset: number
  /** Label values (pre-offset) the user has ticked. */
  selected: Set<number>
  /** When true only ticked regions are drawn. */
  isolate: boolean
  search: string
  atlasName: string | null

  /** Per-region scalar values, when a value file has been loaded. */
  scalar: ScalarField | null
  /** Colormap key for the heatmap. */
  colormap: string
  /** Flip the colormap end for end (e.g. Red–Blue → Blue–Red). */
  reversed: boolean
  /** Centre a diverging map on zero; ignored for sequential maps. */
  symmetric: boolean
  /** Active display domain [min, max]; null means follow the data range. */
  range: { min: number; max: number } | null
}

type Listener = (state: AppState) => void

export class Store {
  private state: AppState = {
    table: null,
    mode: 'volume',
    reconciliation: null,
    offset: 0,
    selected: new Set(),
    isolate: false,
    search: '',
    atlasName: null,
    scalar: null,
    colormap: 'viridis',
    reversed: false,
    symmetric: false,
    range: null,
  }

  private listeners: Listener[] = []

  get(): Readonly<AppState> {
    return this.state
  }

  subscribe(listener: Listener): void {
    this.listeners.push(listener)
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  toggleSelected(value: number): void {
    const selected = new Set(this.state.selected)
    if (selected.has(value)) selected.delete(value)
    else selected.add(value)
    this.update({ selected })
  }

  setRegionColor(value: number, color: RGB): void {
    const table = this.state.table
    if (!table) return
    const regions = table.regions.map((r) =>
      r.value === value ? { ...r, color, colorSynthesised: false } : r,
    )
    this.update({ table: { ...table, regions } })
  }

  /** Regions matching the current search, in label-value order. */
  visibleRegions(): LabelTable['regions'] {
    const { table, search } = this.state
    if (!table) return []
    const needle = search.trim().toLowerCase()
    if (needle === '') return table.regions
    const terms = needle.split(/\s+/)
    return table.regions.filter((r) => {
      const haystack = `${r.name} ${r.abbreviation ?? ''} ${r.value}`.toLowerCase()
      return terms.every((t) => haystack.includes(t))
    })
  }
}
