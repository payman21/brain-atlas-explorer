import './style.css'
import { AtlasViewer, type LayoutName } from './viewer/atlasViewer.ts'
import { BUNDLED_SURFACES, DEFAULT_ZOOM, SurfaceView } from './viewer/surfaceView.ts'
import { parseLabelFile, reconcileValues, type Reconciliation } from './labels/parse.ts'
import { LabelParseError, type LabelTable, type Region } from './labels/types.ts'
import { parseCiftiDlabel } from './labels/formats/cifti.ts'
import { parseGiftiLabel } from './labels/formats/gifti.ts'
import type { Parcellation } from './labels/grayordinates.ts'
import { Store, type ViewMode } from './state.ts'
import { MessageArea, type Message } from './ui/messages.ts'
import { formatScalar, RegionList, type RegionSize } from './ui/regionList.ts'
import { attachDropzone, hemisphereOf, sortFiles } from './ui/ingest.ts'
import { hexToRgb, rgbToHex } from './viewer/colors.ts'
import { cssGradient, getColormap, listColormaps } from './viewer/colormaps.ts'
import { parseValues, ValueParseError, type ScalarField } from './scalars/values.ts'
import { buildHeatmap, heatmapRegions, suggestColormap, type Heatmap } from './scalars/heatmap.ts'

const TEMPLATE_URL = '/templates/mni152.nii.gz'
const DEMO = { volume: '/samples/aal.nii.gz', labels: '/samples/aal.json' }

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

const store = new Store()
const messages = new MessageArea(el('messages'))

/** Label values present in the loaded volume; empty until an atlas arrives. */
let volumeValues = new Set<number>()

/** Kept so the surface controls can rebuild with different geometry. */
let lastSurfaceFiles: File[] = []

const viewer = await AtlasViewer.create(el<HTMLCanvasElement>('gl'), el<HTMLCanvasElement>('gl-render'))
await viewer.loadTemplate(TEMPLATE_URL)

const surfaceView = new SurfaceView(el('surface-grid'))

const regionList = new RegionList(el('region-list'), {
  onToggle: (value) => store.toggleSelected(value),
  onRecolor: (value, hex) => store.setRegionColor(value, hexToRgb(hex)),
  onJump: (value) => jumpTo(value),
})

// ---------------------------------------------------------------- rendering

/** How much of the scene a region occupies, in whichever path is active. */
function sizeOf(value: number): RegionSize {
  const { mode, offset } = store.get()
  if (mode === 'surface') {
    const vertices = surfaceView.vertexCount(value)
    return { voxels: 0, vertices, total: vertices }
  }
  const voxels = viewer.voxelCount(value + offset)
  return { voxels, vertices: 0, total: voxels }
}

function paint(regions: Region[], visible: Set<number> | null, offset: number, mode: ViewMode): void {
  if (mode === 'surface') surfaceView.paint(regions, visible)
  else viewer.applyLabels(regions, visible, offset)
}

/** The heatmap for the current settings, or null when no values are loaded. */
let heatmap: Heatmap | null = null

store.subscribe((state) => {
  const { table, offset, selected, isolate, mode, scalar } = state

  el('atlas-name').textContent = state.atlasName
    ? `${state.atlasName}${table ? ` · ${table.format}` : ''}`
    : 'No parcellation loaded'

  // The two paths own different canvases and different toolbar controls.
  document.querySelector('.stage')?.setAttribute('data-mode', mode)
  el('volume-viewport').hidden = mode === 'surface'
  el('surface-grid').hidden = mode !== 'surface'

  el('region-controls').hidden = table === null
  if (!table) {
    el('region-list').replaceChildren()
    heatmap = null
    updateScalarUI(null)
    return
  }

  // When a value file is loaded, regions are recoloured by their scalar; the
  // categorical colours drive nothing until the values are cleared.
  heatmap = scalar ? buildHeatmap(scalar, state.colormap, state.symmetric, state.range, state.reversed) : null
  const paintRegions = scalar && heatmap ? heatmapRegions(table.regions, scalar, heatmap) : table.regions
  updateScalarUI(scalar ? { scalar, heatmap: heatmap! } : null)

  const shown = filterRegions(paintRegions, state.search)
  el('region-count').textContent =
    `${shown.length} of ${table.regions.length} shown · ${selected.size} selected`

  regionList.render(shown, selected, sizeOf, scalar ? (v) => scalar.values.get(v) : undefined)

  const visible = isolate ? new Set([...selected].map((v) => (mode === 'surface' ? v : v + offset))) : null
  paint(paintRegions, visible, offset, mode)
})

/** Search over the display regions, mirroring `Store.visibleRegions`. */
function filterRegions(regions: Region[], search: string): Region[] {
  const needle = search.trim().toLowerCase()
  if (needle === '') return regions
  const terms = needle.split(/\s+/)
  return regions.filter((r) => {
    const haystack = `${r.name} ${r.abbreviation ?? ''} ${r.value}`.toLowerCase()
    return terms.every((t) => haystack.includes(t))
  })
}

function jumpTo(value: number): void {
  const { mode, offset } = store.get()
  if (mode === 'surface') {
    // Surface panels are fixed views of a whole hemisphere, so there is nothing
    // to centre on. Toggling instead keeps clicking rows additive, which is what
    // building up a multi-region selection needs.
    if (!surfaceView.hemisphereOf(value)) {
      messages.show([{ kind: 'warn', text: 'That region has no vertices on the loaded surfaces.' }])
      return
    }
    store.toggleSelected(value)
    return
  }
  if (!viewer.jumpToRegion(value + offset)) {
    messages.show([{ kind: 'warn', text: 'That region has no voxels in the loaded volume.' }])
  }
}

// ---------------------------------------------------------------- ingestion

async function ingest(files: File[]): Promise<void> {
  const sorted = sortFiles(files)
  const pending: Message[] = []

  if (sorted.ignored.length) {
    pending.push({ kind: 'warn', text: 'Some files were not recognised and were ignored:', details: sorted.ignored })
  }

  try {
    if (sorted.cifti) {
      lastSurfaceFiles = files
      await ingestSurface(await parseCiftiDlabel(await sorted.cifti.arrayBuffer()), sorted.cifti.name, sorted.surfaces, pending)
    } else if (sorted.gifti.length > 0) {
      lastSurfaceFiles = files
      await ingestGifti(sorted.gifti, sorted.surfaces, pending)
    } else if (!sorted.volume && sorted.labels && store.get().table) {
      // A lone data file dropped onto a loaded parcellation is region values,
      // not a new atlas — there is no new volume for it to label.
      await ingestValues(sorted.labels, pending)
    } else if (sorted.volume || sorted.labels) {
      lastSurfaceFiles = []
      await ingestVolume(sorted.volume, sorted.labels, pending)
    } else if (sorted.surfaces.length > 0) {
      pending.push({
        kind: 'warn',
        text: 'Surface geometry alone has nothing to show. Add a .label.gii or .dlabel.nii carrying the parcellation.',
      })
    }
  } catch (err) {
    pending.push({
      kind: 'error',
      text: err instanceof LabelParseError ? `Could not read the file: ${err.message}` : String(err),
    })
  }

  messages.show(pending)
}

/** Match a value file to the loaded parcellation and switch on the heatmap. */
async function ingestValues(file: File, pending: Message[]): Promise<void> {
  const table = store.get().table
  if (!table) {
    pending.push({ kind: 'warn', text: 'Load a parcellation before loading region values.' })
    return
  }

  let scalar: ScalarField
  try {
    scalar = parseValues(file.name, await file.text(), table.regions)
  } catch (err) {
    pending.push({
      kind: 'error',
      text: err instanceof ValueParseError ? `Could not read the values: ${err.message}` : String(err),
    })
    return
  }

  const suggestion = suggestColormap(scalar)
  store.update({ scalar, colormap: suggestion.colormap, symmetric: suggestion.symmetric, reversed: false, range: null })
  el<HTMLSelectElement>('colormap').value = suggestion.colormap
  el<HTMLInputElement>('symmetric').checked = suggestion.symmetric
  el<HTMLInputElement>('reverse').checked = false

  const how =
    scalar.matchedBy === 'name'
      ? 'by region name'
      : scalar.matchedBy === 'index'
        ? 'by label value'
        : 'by row order (positional — verify against a known region)'
  pending.push({
    kind: scalar.matchedBy === 'order' ? 'warn' : 'info',
    text: `Loaded ${scalar.values.size} value(s), matched ${how}. Range ${scalar.dataMin} … ${scalar.dataMax}.`,
  })
  if (scalar.unmatched.length) {
    pending.push({
      kind: 'warn',
      text: `${scalar.unmatched.length} value(s) in the file matched no region and were dropped:`,
      details: scalar.unmatched,
    })
  }
  if (scalar.missing > 0) {
    pending.push({
      kind: 'info',
      text: `${scalar.missing} region(s) have no value and are drawn in neutral grey.`,
    })
  }
}

function clearValues(): void {
  store.update({ scalar: null, range: null })
  messages.clear()
}

// ---------------------------------------------------------------- scalar UI

/** Show/hide and populate the heatmap controls and colourbar for the state. */
function updateScalarUI(active: { scalar: ScalarField; heatmap: Heatmap } | null): void {
  el('scalar-group').hidden = active === null
  el('clear-values').hidden = active === null
  el('colorbar').hidden = active === null
  if (!active) return

  const { scalar, heatmap } = active
  el('colorbar-gradient').style.background = `linear-gradient(to right, ${cssGradient(heatmap.colormap, heatmap.reversed)})`
  el('colorbar-min').textContent = formatScalar(heatmap.min)
  el('colorbar-max').textContent = formatScalar(heatmap.max)

  // The symmetric toggle only means anything for a diverging colormap.
  el('symmetric-wrap').hidden = heatmap.colormap.kind !== 'diverging'

  // Reflect the active domain in the range inputs without stealing focus.
  const minInput = el<HTMLInputElement>('range-min')
  const maxInput = el<HTMLInputElement>('range-max')
  if (document.activeElement !== minInput) minInput.value = String(round4(heatmap.min))
  if (document.activeElement !== maxInput) maxInput.value = String(round4(heatmap.max))
  void scalar
}

function round4(v: number): number {
  return Number(v.toPrecision(4))
}

/** Volumetric path: a labelled NIfTI with an optional sidecar label table. */
async function ingestVolume(volume: File | null, labels: File | null, pending: Message[]): Promise<void> {
  surfaceView.clear()

  if (volume) {
    volumeValues = await viewer.loadAtlas(volume)
    store.update({ atlasName: volume.name, mode: 'volume' })
  }

  if (labels) {
    applyTable(parseLabelFile(labels.name, await labels.text()), volumeValues, pending)
  } else if (volume) {
    // A volume with no table still deserves a usable view.
    const table = tableFromVolume(volumeValues)
    applyTable(table, volumeValues, pending)
    pending.push({
      kind: 'info',
      text: `No label table supplied — ${table.regions.length} label values were read from the volume and named by number.`,
    })
  }
}

/** One or two GIFTI label files, merged into a single parcellation. */
async function ingestGifti(files: File[], userSurfaces: File[], pending: Message[]): Promise<void> {
  const parsed = await Promise.all(files.map(async (f) => parseGiftiLabel(await f.arrayBuffer(), f.name)))

  // Both hemispheres of one atlas share a label table; merge by label value.
  const merged = new Map<number, Region>()
  for (const p of parsed) for (const r of p.table.regions) if (!merged.has(r.value)) merged.set(r.value, r)

  await ingestSurface(
    {
      table: { regions: [...merged.values()], format: parsed[0].table.format, warnings: [] },
      surfaces: parsed.flatMap((p) => p.surfaces),
      volume: null,
      summary: parsed.map((p) => p.summary).join(' + '),
    },
    files.map((f) => f.name).join(' + '),
    userSurfaces,
    pending,
  )
}

/** Surface path: cortical labels painted onto fixed lateral/medial views. */
async function ingestSurface(
  parcellation: Parcellation,
  name: string,
  userSurfaces: File[],
  pending: Message[],
): Promise<void> {
  viewer.clearAtlas()
  volumeValues = new Set()

  const geometry = resolveGeometry(parcellation, userSurfaces, pending)
  const { missing } = await surfaceView.load(parcellation.surfaces, geometry)
  surfaceView.setBackground(el<HTMLSelectElement>('surface-background').value as 'dark' | 'light')

  if (missing.length) {
    pending.push({
      kind: 'warn',
      text:
        `No matching surface geometry for ${missing.map((m) => m.hemisphere).join(' and ')} ` +
        `(${missing[0].vertexCount.toLocaleString()} vertices). Drop the matching .surf.gii files to see that cortex.`,
    })
  }

  // Drop regions that no loaded hemisphere carries. A one-hemisphere GIFTI
  // ships the whole atlas's label table, so without this the list is mostly
  // entries the view can never show.
  const present = surfaceView.labelValues()
  const regions = parcellation.table.regions.filter((r) => present.has(r.value))
  const dropped = parcellation.table.regions.length - regions.length
  if (dropped > 0) {
    pending.push({
      kind: 'info',
      text: `${dropped} region(s) in the label table are not on the loaded surface(s) and were left out of the list.`,
    })
  }

  store.update({ atlasName: `${name} — ${parcellation.summary}`, mode: 'surface' })
  applyTable({ ...parcellation.table, regions }, present, pending)
}

/**
 * Match each hemisphere's labels to geometry: a user-supplied `.surf.gii` wins,
 * otherwise fall back to a bundled mesh with the same vertex count.
 */
function resolveGeometry(
  parcellation: Parcellation,
  userSurfaces: File[],
  pending: Message[],
): Partial<Record<'L' | 'R', string | File>> {
  const geometry: Partial<Record<'L' | 'R', string | File>> = {}
  for (const file of userSurfaces) geometry[hemisphereOf(file.name)] = file

  const style = el<HTMLSelectElement>('surface-style').value
  for (const surface of parcellation.surfaces) {
    if (geometry[surface.hemisphere]) continue
    const bundled = BUNDLED_SURFACES[surface.vertexCount]?.[surface.hemisphere]?.[style]
    if (bundled) geometry[surface.hemisphere] = bundled
  }

  if (userSurfaces.length > 0) {
    pending.push({ kind: 'info', text: `Using your surface geometry: ${userSurfaces.map((f) => f.name).join(', ')}.` })
  }
  return geometry
}

function applyTable(table: LabelTable, present: Set<number>, pending: Message[]): void {
  // CIFTI and GIFTI carry their label table inside the file, so its values are
  // aligned by construction and no offset search is warranted.
  const embedded = store.get().mode === 'surface'
  const reconciliation =
    present.size > 0 && !embedded
      ? reconcileValues(table, present)
      : ({ offset: 0, coverage: 1, unnamed: [], empty: 0 } satisfies Reconciliation)

  // A search or value overlay left over from the previous atlas would apply to
  // the wrong regions, so everything view-related resets with the table.
  store.update({
    table,
    reconciliation,
    offset: reconciliation.offset,
    selected: new Set(),
    isolate: false,
    search: '',
    scalar: null,
    range: null,
  })
  el<HTMLSelectElement>('offset').value = String(reconciliation.offset)
  el<HTMLInputElement>('search').value = ''
  el<HTMLInputElement>('isolate').checked = false
  clearReadout()

  if (table.warnings.length) {
    pending.push({ kind: 'warn', text: 'The label table parsed with warnings:', details: table.warnings })
  }
  if (present.size === 0) return

  if (reconciliation.offset !== 0) {
    pending.push({
      kind: 'info',
      text:
        `Label values were shifted by ${reconciliation.offset > 0 ? '+' : ''}${reconciliation.offset} to match ` +
        `the volume. Use the offset control in the toolbar if the names look wrong.`,
    })
  }
  if (reconciliation.unnamed.length) {
    pending.push({
      kind: 'warn',
      text: `${reconciliation.unnamed.length} label value(s) in the data are not named in the table:`,
      details: reconciliation.unnamed.map(String),
    })
  }
  if (reconciliation.empty > 0) {
    pending.push({
      kind: 'warn',
      text: `${reconciliation.empty} region(s) in the table match nothing in the scene; they are greyed out in the list.`,
    })
  }
}

/** Fallback table for a volume dropped without any labels. */
function tableFromVolume(values: Set<number>): LabelTable {
  const regions = [...values]
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      name: `Label ${value}`,
      color: [128, 128, 128] as [number, number, number],
      colorSynthesised: true,
    }))
  return { regions, format: 'derived from volume', warnings: [] }
}

// ---------------------------------------------------------------- wiring

attachDropzone(el('dropzone'), ingest)

el<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement
  if (input.files?.length) void ingest(Array.from(input.files))
  input.value = ''
})

el('load-demo').addEventListener('click', async () => {
  messages.show([{ kind: 'info', text: 'Loading the AAL demo atlas…' }])
  const [volume, labels] = await Promise.all([fetchAsFile(DEMO.volume), fetchAsFile(DEMO.labels)])
  await ingest([volume, labels])
})

el<HTMLInputElement>('search').addEventListener('input', (e) => {
  store.update({ search: (e.target as HTMLInputElement).value })
})

el('select-all').addEventListener('click', () => {
  store.update({ selected: new Set(store.visibleRegions().map((r) => r.value)) })
})

el('select-none').addEventListener('click', () => {
  store.update({ selected: new Set() })
})

el<HTMLInputElement>('isolate').addEventListener('change', (e) => {
  store.update({ isolate: (e.target as HTMLInputElement).checked })
})

el<HTMLSelectElement>('offset').addEventListener('change', (e) => {
  store.update({ offset: Number((e.target as HTMLSelectElement).value) })
})

el<HTMLSelectElement>('layout').addEventListener('change', (e) => {
  applyLayout((e.target as HTMLSelectElement).value as LayoutName)
})

/** Show the panes the chosen layout needs, then let NiiVue resize into them. */
function applyLayout(layout: LayoutName): void {
  const panes = viewer.setLayout(layout)
  el('slice-pane').hidden = !panes.slices
  el('render-pane').hidden = !panes.render
  // The panes have just changed size; NiiVue only notices when told.
  requestAnimationFrame(() => viewer.refresh())
}

el<HTMLInputElement>('opacity').addEventListener('input', (e) => {
  viewer.setAtlasOpacity(Number((e.target as HTMLInputElement).value) / 100)
})

el<HTMLInputElement>('show-template').addEventListener('change', (e) => {
  viewer.setTemplateVisible((e.target as HTMLInputElement).checked)
})

el<HTMLInputElement>('show-crosshair').addEventListener('change', (e) => {
  viewer.setCrosshairVisible((e.target as HTMLInputElement).checked)
})

// Switching geometry means reloading the meshes, so the last surface files are
// re-ingested rather than patched in place.
el<HTMLSelectElement>('surface-style').addEventListener('change', () => {
  if (lastSurfaceFiles.length > 0) void ingest(lastSurfaceFiles)
})

el<HTMLSelectElement>('surface-background').addEventListener('change', (e) => {
  surfaceView.setBackground((e.target as HTMLSelectElement).value as 'dark' | 'light')
})

el('reset-views').addEventListener('click', () => surfaceView.resetViews())

// Surface panel zoom: the slider drives all four panels, and scrolling any
// panel feeds back into the slider so it always shows the current size.
const zoomSlider = el<HTMLInputElement>('surface-zoom')
zoomSlider.addEventListener('input', () => surfaceView.setZoom(Number(zoomSlider.value)))
el('reset-zoom').addEventListener('click', () => surfaceView.setZoom(DEFAULT_ZOOM))
surfaceView.onZoomChange((zoom) => {
  zoomSlider.value = String(zoom)
})

// ---- region values / heatmap ----

// Populate the colormap picker once, grouped sequential then diverging.
for (const cm of listColormaps()) {
  const option = document.createElement('option')
  option.value = cm.key
  option.textContent = cm.label
  el('colormap').append(option)
}

el<HTMLInputElement>('values-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement
  if (input.files?.length) void loadValueFile(input.files[0])
  input.value = ''
})

async function loadValueFile(file: File): Promise<void> {
  const pending: Message[] = []
  await ingestValues(file, pending)
  messages.show(pending)
}

el('clear-values').addEventListener('click', clearValues)

el<HTMLSelectElement>('colormap').addEventListener('change', (e) => {
  // A colormap change may cross the sequential/diverging line, so re-derive the
  // symmetric default and drop any manual range that no longer fits.
  const key = (e.target as HTMLSelectElement).value
  const symmetric = getColormap(key).kind === 'diverging' && store.get().symmetric
  store.update({ colormap: key, symmetric, range: null })
  el<HTMLInputElement>('symmetric').checked = symmetric
})

el<HTMLInputElement>('reverse').addEventListener('change', (e) => {
  store.update({ reversed: (e.target as HTMLInputElement).checked })
})

el<HTMLInputElement>('symmetric').addEventListener('change', (e) => {
  store.update({ symmetric: (e.target as HTMLInputElement).checked, range: null })
})

el('range-auto').addEventListener('click', () => store.update({ range: null }))

for (const id of ['range-min', 'range-max'] as const) {
  el<HTMLInputElement>(id).addEventListener('change', () => {
    const min = Number(el<HTMLInputElement>('range-min').value)
    const max = Number(el<HTMLInputElement>('range-max').value)
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      store.update({ range: { min, max } })
    }
  })
}

el('export-png').addEventListener('click', async () => {
  const button = el<HTMLButtonElement>('export-png')
  const scale = Number(el<HTMLSelectElement>('export-scale').value)
  const { mode, atlasName } = store.get()

  button.disabled = true
  button.textContent = 'Rendering…'
  try {
    const blob = mode === 'surface' ? await surfaceView.toPng(scale) : await viewer.toPng(scale)
    if (!blob) {
      messages.show([{ kind: 'warn', text: 'Nothing to export yet — load a parcellation first.' }])
      return
    }
    const stem = (atlasName ?? 'atlas').split(/[ .]/)[0] || 'atlas'
    downloadBlob(blob, `${stem}-${mode}-${scale}x.png`)
  } catch (err) {
    messages.show([{ kind: 'error', text: `Export failed: ${String(err)}` }])
  } finally {
    button.disabled = false
    button.textContent = 'Save PNG'
  }
})

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------- readout

/** A readout left over from the previous atlas would name a region that is gone. */
function clearReadout(): void {
  const empty = document.createElement('span')
  empty.className = 'readout-empty'
  empty.textContent = 'Click the brain to identify a region.'
  el('readout-body').replaceChildren(empty)
}

function showReadout(value: number, detail: string, coordsText: string): void {
  const body = el('readout-body')
  const { table, offset, mode, scalar } = store.get()
  const lookup = mode === 'surface' ? value : value - offset
  const region = table?.regions.find((r) => r.value === lookup)

  const coords = document.createElement('span')
  coords.className = 'readout-coords'
  coords.textContent = coordsText

  if (!region) {
    const label = document.createElement('span')
    label.className = 'readout-empty'
    label.textContent = value === 0 ? 'Unlabelled' : `Unlabelled value ${value}`
    body.replaceChildren(label, coords)
    return
  }

  const swatch = document.createElement('span')
  swatch.className = 'readout-swatch'
  // In heatmap mode the swatch shows the region's mapped colour, not its
  // categorical one, so it matches what is on screen.
  swatch.style.background = rgbToHex(heatmap && scalar ? heatmapColorFor(region.value) : region.color)

  const name = document.createElement('span')
  name.className = 'readout-name'
  name.textContent = region.name

  const meta = document.createElement('span')
  meta.className = 'region-meta'
  const scalarValue = scalar?.values.get(region.value)
  const scalarText = scalar
    ? scalarValue === undefined
      ? ' · no value'
      : ` · value ${formatScalar(scalarValue)}`
    : ''
  meta.textContent = `#${region.value} · ${detail}${scalarText}`

  body.replaceChildren(swatch, name, meta, coords)
}

function heatmapColorFor(regionValue: number): [number, number, number] {
  const { scalar } = store.get()
  const v = scalar?.values.get(regionValue)
  if (!heatmap || v === undefined) return [70, 76, 88]
  return heatmap.colorOf(v)
}

viewer.onPick((pick) => {
  showReadout(
    pick.value,
    `${viewer.voxelCount(pick.value).toLocaleString()} voxels`,
    `MNI ${pick.mm.map((v) => v.toFixed(0)).join(', ')} · vox ${pick.vox.join(', ')}`,
  )
})

surfaceView.onPick((pick) => {
  showReadout(
    pick.value,
    `${surfaceView.vertexCount(pick.value).toLocaleString()} vertices · ${pick.hemisphere === 'L' ? 'left' : 'right'} cortex`,
    `${pick.mm.map((v) => v.toFixed(0)).join(', ')}`,
  )
})

async function fetchAsFile(url: string): Promise<File> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not fetch ${url} (${response.status})`)
  return new File([await response.blob()], url.split('/').pop()!)
}
