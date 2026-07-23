import { Niivue, NVMesh, SLICE_TYPE } from '@niivue/niivue'
import type { Region } from '../labels/types.ts'
import type { SurfaceLabels } from '../labels/grayordinates.ts'
import { drawLegend, legendHeight, type Legend } from './legend.ts'

/** Geometry bundled with the app, keyed by the vertex count it fits. */
export const BUNDLED_SURFACES: Record<number, Record<'L' | 'R', Record<string, string>>> = {
  32492: {
    L: {
      inflated: '/surfaces/fsLR32k.L.inflated.surf.gii',
      midthickness: '/surfaces/fsLR32k.L.midthickness.surf.gii',
    },
    R: {
      inflated: '/surfaces/fsLR32k.R.inflated.surf.gii',
      midthickness: '/surfaces/fsLR32k.R.midthickness.surf.gii',
    },
  },
}

export type SurfaceStyle = 'inflated' | 'midthickness'
export type PanelView = 'lateral' | 'medial'

export interface PanelSpec {
  hemisphere: 'L' | 'R'
  view: PanelView
}

/**
 * The four views that make up a conventional surface figure, in the order
 * they are normally laid out: left lateral, right lateral above, left medial,
 * right medial below.
 */
export const FIGURE_PANELS: PanelSpec[] = [
  { hemisphere: 'L', view: 'lateral' },
  { hemisphere: 'R', view: 'lateral' },
  { hemisphere: 'L', view: 'medial' },
  { hemisphere: 'R', view: 'medial' },
]

/**
 * Camera azimuth per hemisphere and view.
 *
 * NiiVue's azimuth is degrees about the superior-inferior axis, so viewing the
 * left hemisphere from the left (its lateral face) and viewing it from the
 * right (its medial face) are 180 degrees apart.
 */
const AZIMUTH: Record<'L' | 'R', Record<PanelView, number>> = {
  L: { lateral: 90, medial: 270 },
  R: { lateral: 270, medial: 90 },
}

interface Panel extends PanelSpec {
  nv: Niivue
  canvas: HTMLCanvasElement
  mesh: NVMesh | null
  values: Int32Array
}

export interface SurfacePick {
  value: number
  mm: [number, number, number]
  hemisphere: 'L' | 'R'
}

export const DEFAULT_ZOOM = 1
export const ZOOM_RANGE = { min: 0.5, max: 3 }

/**
 * Publication-style surface viewer: one small WebGL canvas per view, each
 * showing a single hemisphere from a fixed angle with no template, no slices
 * and no crosshair.
 *
 * A single NiiVue instance has one camera, so separate views mean separate
 * instances. Four contexts is well inside what browsers allow, and it keeps
 * each panel's angle independent.
 */
export class SurfaceView {
  private panels: Panel[] = []
  private readonly host: HTMLElement
  private pickHandler: ((pick: SurfacePick) => void) | null = null
  private background: [number, number, number, number] = [0.05, 0.06, 0.09, 1]
  private counts = new Map<number, number>()

  /** Shared zoom across all panels, so lateral and medial never diverge. */
  private zoom = DEFAULT_ZOOM
  private syncingZoom = false
  private zoomListener: ((zoom: number) => void) | null = null

  constructor(host: HTMLElement) {
    this.host = host
  }

  getZoom(): number {
    return this.zoom
  }

  /** Notified whenever the shared zoom changes, including from scrolling. */
  onZoomChange(listener: (zoom: number) => void): void {
    this.zoomListener = listener
  }

  /** Set one zoom for every panel; the reset button calls this with 1. */
  setZoom(zoom: number): void {
    this.zoom = clampZoom(zoom)
    this.syncingZoom = true
    for (const panel of this.panels) panel.nv.volScaleMultiplier = this.zoom
    this.syncingZoom = false
    this.zoomListener?.(this.zoom)
  }

  get isEmpty(): boolean {
    return this.panels.length === 0
  }

  vertexCount(value: number): number {
    return this.counts.get(value) ?? 0
  }

  labelValues(): Set<number> {
    return new Set(this.counts.keys())
  }

  /**
   * Tear down every panel, explicitly releasing each WebGL context.
   *
   * Dropping the canvas from the DOM is not enough: browsers cap the number of
   * live contexts (often 16) and reclaim them lazily, so rebuilding the grid a
   * few times — switching inflated to midthickness, say — silently starves the
   * last panels of a context and they render blank.
   */
  clear(): void {
    for (const panel of this.panels) {
      const lose = panel.nv.gl?.getExtension('WEBGL_lose_context')
      lose?.loseContext()
    }
    this.panels = []
    this.host.replaceChildren()
    this.counts = new Map()
  }

  /**
   * Build one panel per requested view, skipping any hemisphere with no
   * geometry. Returns the hemispheres that could not be shown.
   */
  async load(
    surfaces: SurfaceLabels[],
    geometry: Partial<Record<'L' | 'R', string | File>>,
    specs: PanelSpec[] = FIGURE_PANELS,
  ): Promise<{ missing: SurfaceLabels[] }> {
    this.clear()
    const missing: SurfaceLabels[] = []
    const byHemisphere = new Map(surfaces.map((s) => [s.hemisphere, s]))

    for (const spec of specs) {
      const surface = byHemisphere.get(spec.hemisphere)
      if (!surface) continue

      const source = geometry[spec.hemisphere]
      if (!source) {
        if (!missing.includes(surface)) missing.push(surface)
        continue
      }
      this.panels.push(await this.buildPanel(spec, surface, source))
    }

    this.recount()
    return { missing }
  }

  private async buildPanel(
    spec: PanelSpec,
    surface: SurfaceLabels,
    source: string | File,
  ): Promise<Panel> {
    const wrapper = document.createElement('div')
    wrapper.className = 'surface-panel'

    const canvas = document.createElement('canvas')
    const caption = document.createElement('span')
    caption.className = 'surface-caption'
    caption.textContent = `${spec.hemisphere === 'L' ? 'Left' : 'Right'} ${spec.view}`
    wrapper.append(canvas, caption)
    this.host.append(wrapper)

    const nv = new Niivue({
      backColor: this.background,
      show3Dcrosshair: false,
      isColorbar: false,
      dragAndDropEnabled: false,
    })
    await nv.attachToCanvas(canvas)
    nv.setSliceType(SLICE_TYPE.RENDER)

    // NiiVue picks its mesh reader from the extension in `name`, so the name
    // must keep the real filename rather than a friendly label.
    const mesh =
      typeof source === 'string'
        ? await NVMesh.loadFromUrl({ url: source, gl: nv.gl, name: source.split('/').pop() ?? 's.surf.gii' })
        : await NVMesh.loadFromFile({ file: source, gl: nv.gl, name: source.name })

    const meshVertices = mesh.pts.length / 3
    if (meshVertices !== surface.vertexCount) {
      throw new Error(
        `${spec.hemisphere} surface has ${meshVertices.toLocaleString()} vertices but the labels describe ` +
          `${surface.vertexCount.toLocaleString()}. They come from different meshes.`,
      )
    }

    nv.addMesh(mesh)
    nv.setRenderAzimuthElevation(AZIMUTH[spec.hemisphere][spec.view], 0)
    // Start the panel at the shared zoom, so rebuilding on a style change keeps
    // whatever zoom the user had set.
    nv.volScaleMultiplier = this.zoom

    const panel: Panel = { ...spec, nv, canvas, mesh, values: surface.values }

    // Scrolling zooms one panel; mirror it to the others so the four views stay
    // the same size. The guard stops the mirrored writes from echoing back.
    nv.onZoom3DChange = (zoom) => {
      if (this.syncingZoom) return
      this.zoom = clampZoom(zoom)
      this.syncingZoom = true
      for (const other of this.panels) {
        if (other.nv !== nv) other.nv.volScaleMultiplier = this.zoom
      }
      this.syncingZoom = false
      this.zoomListener?.(this.zoom)
    }

    // NiiVue's own picking cannot help here: its depth picker resolves a hit
    // through `mm2frac`, which needs a loaded volume, and `onLocationChange`
    // only fires for volume crosshair moves. A mesh-only scene has neither, so
    // the click is resolved against the vertices directly.
    canvas.addEventListener('click', (event) => {
      if (!this.pickHandler) return
      const hit = pickVertex(panel, event)
      if (hit) this.pickHandler({ ...hit, hemisphere: panel.hemisphere })
    })
    return panel
  }

  /**
   * Repaint every panel. `visible` is the set of label values to draw, or null
   * to draw them all; hidden regions get zero alpha and fall back to the mesh's
   * own unlabelled grey.
   */
  paint(regions: Region[], visible: Set<number> | null): void {
    if (this.panels.length === 0) return

    const I = [0]
    const R = [0]
    const G = [0]
    const B = [0]
    const A = [0]
    const labels = ['']

    for (const region of regions) {
      if (region.value === 0) continue
      I.push(region.value)
      R.push(region.color[0])
      G.push(region.color[1])
      B.push(region.color[2])
      A.push(visible === null || visible.has(region.value) ? 255 : 0)
      labels.push(region.name)
    }

    const colormapLabel = { R, G, B, A, I, labels }
    const maxValue = Math.max(1, ...I)

    for (const panel of this.panels) {
      if (!panel.mesh) continue
      const layer = panel.mesh.layers[0]
      if (layer) {
        layer.colormapLabel = colormapLabel
      } else {
        panel.mesh.layers.push({
          name: 'parcellation',
          opacity: 1,
          colormap: 'rocket',
          colormapLabel,
          values: panel.values,
          cal_min: 0,
          cal_max: maxValue,
          cal_minNeg: 0,
          cal_maxNeg: 0,
          frame4D: 0,
          nFrame4D: 1,
          colorbarVisible: false,
        })
      }
      panel.mesh.updateMesh(panel.nv.gl)
      panel.nv.drawScene()
    }
  }

  onPick(handler: (pick: SurfacePick) => void): void {
    this.pickHandler = handler
  }

  private backgroundMode: 'dark' | 'light' = 'dark'

  /** Whether the current background is dark, so a legend can pick its ink. */
  get isDark(): boolean {
    return this.backgroundMode === 'dark'
  }

  /** Light backgrounds are what journals expect; dark suits screen use. */
  setBackground(mode: 'dark' | 'light'): void {
    this.backgroundMode = mode
    this.background = mode === 'light' ? [1, 1, 1, 1] : [0.05, 0.06, 0.09, 1]
    this.host.classList.toggle('light', mode === 'light')
    for (const panel of this.panels) {
      panel.nv.opts.backColor = this.background
      panel.nv.drawScene()
    }
  }

  /**
   * Render the panel grid to a single PNG at `scale`× the on-screen size.
   *
   * Each panel is re-rendered into an enlarged drawing buffer rather than the
   * displayed canvas being upscaled, so the result is genuinely higher
   * resolution — text-free vector-like edges at 4× are clean enough for print.
   * Still a raster image: see the export note in the README.
   */
  async toPng(scale = 4, legend: Legend | null = null): Promise<Blob | null> {
    if (this.panels.length === 0) return null

    const columns = this.panels.length > 1 ? 2 : 1
    const rows = Math.ceil(this.panels.length / columns)
    const first = this.panels[0].canvas
    const tileWidth = Math.round(first.clientWidth * scale)
    const tileHeight = Math.round(first.clientHeight * scale)
    const gridWidth = tileWidth * columns
    const legendBand = legend ? legendHeight(gridWidth) : 0

    const sheet = document.createElement('canvas')
    sheet.width = gridWidth
    sheet.height = tileHeight * rows + legendBand
    const ctx = sheet.getContext('2d')
    if (!ctx) return null

    const [r, g, b, a] = this.background
    ctx.fillStyle = `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${a})`
    ctx.fillRect(0, 0, sheet.width, sheet.height)

    for (const [index, panel] of this.panels.entries()) {
      const originalWidth = panel.canvas.width
      const originalHeight = panel.canvas.height
      try {
        panel.canvas.width = tileWidth
        panel.canvas.height = tileHeight
        panel.nv.gl.viewport(0, 0, tileWidth, tileHeight)
        panel.nv.drawScene()
        // The buffer is cleared on swap, so read it back in the same frame.
        await new Promise((resolve) => requestAnimationFrame(resolve))
        panel.nv.drawScene()

        ctx.drawImage(panel.canvas, (index % columns) * tileWidth, Math.floor(index / columns) * tileHeight)
      } finally {
        panel.canvas.width = originalWidth
        panel.canvas.height = originalHeight
        panel.nv.gl.viewport(0, 0, originalWidth, originalHeight)
        panel.nv.drawScene()
      }
    }

    if (legend) drawLegend(ctx, 0, tileHeight * rows, gridWidth, legendBand, legend)
    return new Promise((resolve) => sheet.toBlob((blob) => resolve(blob), 'image/png'))
  }

  /** Spin every panel back to its canonical angle. */
  resetViews(): void {
    for (const panel of this.panels) {
      panel.nv.setRenderAzimuthElevation(AZIMUTH[panel.hemisphere][panel.view], 0)
      panel.nv.drawScene()
    }
  }

  /**
   * Which panel best shows a region, so the UI can point at it. Returns the
   * hemisphere carrying the most vertices with that label.
   */
  hemisphereOf(value: number): 'L' | 'R' | null {
    const totals: Record<'L' | 'R', number> = { L: 0, R: 0 }
    for (const panel of this.panels) {
      if (panel.view !== 'lateral') continue
      for (const v of panel.values) if (v === value) totals[panel.hemisphere]++
    }
    if (totals.L === 0 && totals.R === 0) return null
    return totals.L >= totals.R ? 'L' : 'R'
  }

  private recount(): void {
    this.counts = new Map()
    // Count each hemisphere once; lateral and medial panels share vertex data.
    const seen = new Set<'L' | 'R'>()
    for (const panel of this.panels) {
      if (seen.has(panel.hemisphere)) continue
      seen.add(panel.hemisphere)
      for (const value of panel.values) {
        if (value === 0) continue
        this.counts.set(value, (this.counts.get(value) ?? 0) + 1)
      }
    }
  }
}

/** Click radius in device pixels within which a vertex counts as hit. */
const PICK_RADIUS = 14

/**
 * Resolve a click to a vertex by projecting the mesh with the same matrix
 * NiiVue renders it with, then taking the frontmost vertex near the cursor.
 *
 * Nearest-in-screen-space alone is not enough: a lateral view of an inflated
 * hemisphere has the medial surface directly behind it, and without the depth
 * comparison a click can report the region on the far side.
 */
function pickVertex(
  panel: Panel,
  event: MouseEvent,
): { value: number; mm: [number, number, number] } | null {
  if (!panel.mesh) return null

  const canvas = panel.canvas
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  const clickX = (event.clientX - rect.left) * scaleX
  const clickY = (event.clientY - rect.top) * scaleY

  const mvp = panel.nv.calculateMvpMatrix(
    null,
    [0, 0, canvas.width, canvas.height],
    panel.nv.scene.renderAzimuth,
    panel.nv.scene.renderElevation,
  )[0]

  const pts = panel.mesh.pts
  let bestValue: number | null = null
  let bestPoint: [number, number, number] = [0, 0, 0]
  let bestDepth = Infinity

  for (let v = 0, i = 0; i < pts.length; v++, i += 3) {
    const x = pts[i]
    const y = pts[i + 1]
    const z = pts[i + 2]

    // gl-matrix stores matrices column-major.
    const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15]
    if (cw <= 0) continue
    const cx = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / cw
    const cy = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / cw
    const cz = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / cw

    const screenX = (cx * 0.5 + 0.5) * canvas.width
    const screenY = (1 - (cy * 0.5 + 0.5)) * canvas.height
    const dx = screenX - clickX
    const dy = screenY - clickY
    if (dx * dx + dy * dy > PICK_RADIUS * PICK_RADIUS) continue

    if (cz < bestDepth) {
      bestDepth = cz
      bestValue = panel.values[v]
      bestPoint = [x, y, z]
    }
  }

  if (bestValue === null) return null
  return { value: bestValue, mm: bestPoint }
}

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM
  return Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, zoom))
}
