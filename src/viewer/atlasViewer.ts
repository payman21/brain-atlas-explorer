import { MULTIPLANAR_TYPE, Niivue, NVImage, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue'
import type { Region } from '../labels/types.ts'
import { drawLegend, legendHeight, type Legend } from './legend.ts'

export interface PickResult {
  /** Label value under the crosshair; 0 means background. */
  value: number
  /** World coordinates in the volume's reference space, in millimetres. */
  mm: [number, number, number]
  vox: [number, number, number]
}

export type LayoutName = 'multiplanar' | 'axial' | 'coronal' | 'sagittal' | 'render'

const LAYOUTS: Record<LayoutName, SLICE_TYPE> = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
}

/**
 * The volumetric path: a greyscale anatomical template at volume 0 and a
 * labelled parcellation at volume 1, viewed as orthogonal slices or a 3D
 * render, with the parcellation coloured through a label LUT that is rebuilt
 * whenever selection or colour changes.
 *
 * Surfaces are handled separately by `SurfaceView` — the two paths share a
 * label table and nothing else.
 */
export class AtlasViewer {
  /** Slice pane: the three orthogonal views, laid out in a row. */
  readonly nv: Niivue
  /** Render pane, stacked beneath the slices. */
  readonly render: Niivue
  private atlasLoaded = false
  private voxelCounts = new Map<number, number>()
  private centroids = new Map<number, [number, number, number]>()

  private constructor() {
    const shared = {
      backColor: [0.05, 0.06, 0.09, 1] as [number, number, number, number],
      crosshairColor: [1, 0.85, 0.2, 1] as [number, number, number, number],
      show3Dcrosshair: true,
      dragAndDropEnabled: false, // the app handles drops so it can route label files
    }

    // Two instances rather than one: NiiVue's own multiplanar layouts put the
    // 3D render either in a 2x2 cell or, with heroImageFraction, above the
    // slices — never beneath them. Separate panes give full control of the
    // stacking at the cost of decoding each volume twice.
    this.nv = new Niivue({
      ...shared,
      multiplanarShowRender: SHOW_RENDER.NEVER,
      multiplanarLayout: MULTIPLANAR_TYPE.ROW,
    })
    this.render = new Niivue({ ...shared, show3Dcrosshair: true })
  }

  static async create(sliceCanvas: HTMLCanvasElement, renderCanvas: HTMLCanvasElement): Promise<AtlasViewer> {
    const viewer = new AtlasViewer()
    await viewer.nv.attachToCanvas(sliceCanvas)
    await viewer.render.attachToCanvas(renderCanvas)
    viewer.nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
    viewer.render.setSliceType(SLICE_TYPE.RENDER)
    return viewer
  }

  /** Every pane, for operations that must stay in lockstep. */
  private get panes(): Niivue[] {
    return [this.nv, this.render]
  }

  async loadTemplate(url: string): Promise<void> {
    await Promise.all(this.panes.map((nv) => nv.loadVolumes([{ url, colormap: 'gray', opacity: 1 }])))
  }

  /**
   * Replace the parcellation layer. Returns the set of label values actually
   * present in the image, which drives reconciliation against the label table.
   */
  async loadAtlas(file: File): Promise<Set<number>> {
    // Each pane owns its own GPU textures, so the image is decoded per pane
    // rather than shared.
    for (const nv of this.panes) {
      if (this.atlasLoaded && nv.volumes.length > 1) nv.removeVolumeByIndex(1)
      const image = await NVImage.loadFromFile({ file, name: file.name, colormap: 'gray', opacity: 0.75 })
      nv.addVolume(image)
    }
    this.atlasLoaded = true

    this.indexVoxels(this.nv.volumes[1])
    return new Set(this.voxelCounts.keys())
  }

  /** Remove the parcellation volume, leaving the template in place. */
  clearAtlas(): void {
    if (this.atlasLoaded) {
      for (const nv of this.panes) if (nv.volumes.length > 1) nv.removeVolumeByIndex(1)
    }
    this.atlasLoaded = false
    this.voxelCounts = new Map()
    this.centroids = new Map()
  }

  get hasAtlas(): boolean {
    return this.atlasLoaded
  }

  /** Voxel count for a label value, or 0 if it is absent from the image. */
  voxelCount(value: number): number {
    return this.voxelCounts.get(value) ?? 0
  }

  /** Every label value present in the loaded volume. */
  presentValues(): Set<number> {
    return new Set(this.voxelCounts.keys())
  }

  /**
   * Paint the parcellation.
   *
   * `visible` holds the label values to draw; everything else is given zero
   * alpha so the template shows through. Passing `null` draws every region.
   */
  applyLabels(regions: Region[], visible: Set<number> | null, offset: number): void {
    const I = [0]
    const R = [0]
    const G = [0]
    const B = [0]
    const A = [0] // background is always transparent
    const labels = ['']

    for (const region of regions) {
      const value = region.value + offset
      if (value === 0) continue
      I.push(value)
      R.push(region.color[0])
      G.push(region.color[1])
      B.push(region.color[2])
      A.push(visible === null || visible.has(value) ? 255 : 0)
      labels.push(region.name)
    }

    for (const nv of this.panes) {
      const atlas = nv.volumes[1]
      if (!atlas) continue
      atlas.setColormapLabel({ R, G, B, A, I, labels })
      nv.updateGLVolume()
    }
  }

  setAtlasOpacity(opacity: number): void {
    for (const nv of this.panes) if (nv.volumes[1]) nv.setOpacity(1, opacity)
  }

  setTemplateVisible(visible: boolean): void {
    for (const nv of this.panes) if (nv.volumes[0]) nv.setOpacity(0, visible ? 1 : 0)
  }

  /**
   * Which panes are shown, and how the slice pane is arranged.
   *
   * `multiplanar` is the stacked figure the app defaults to: the three
   * orthogonal slices in a row above, the 3D render below. Single-slice layouts
   * and the standalone render each take the whole area.
   */
  setLayout(layout: LayoutName): { slices: boolean; render: boolean } {
    if (layout === 'render') return { slices: false, render: true }

    this.nv.setSliceType(LAYOUTS[layout])
    return { slices: true, render: layout === 'multiplanar' }
  }

  setCrosshairVisible(visible: boolean): void {
    for (const nv of this.panes) nv.setCrosshairWidth(visible ? 1 : 0)
  }

  /** Redraw after a pane is shown or resized. */
  refresh(): void {
    for (const nv of this.panes) {
      nv.resizeListener()
      nv.drawScene()
    }
  }

  /**
   * Render the visible panes to a PNG at `scale`× their on-screen size, keeping
   * the on-screen stacking: slices above, render below. When a `legend` is
   * given, a colourbar is drawn beneath so the figure explains its own heatmap.
   */
  async toPng(scale = 4, legend: Legend | null = null): Promise<Blob | null> {
    const visible = this.panes.filter((nv) => nv.canvas && (nv.canvas.clientWidth ?? 0) > 0)
    if (visible.length === 0) return null

    const tiles: HTMLCanvasElement[] = []
    for (const nv of visible) tiles.push(await renderAtScale(nv, scale))

    const width = Math.max(...tiles.map((t) => t.width))
    const tilesHeight = tiles.reduce((sum, t) => sum + t.height, 0)
    const legendBand = legend ? legendHeight(width) : 0
    const sheet = document.createElement('canvas')
    sheet.width = width
    sheet.height = tilesHeight + legendBand
    const ctx = sheet.getContext('2d')
    if (!ctx) return null

    ctx.fillStyle = '#0d1017'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    let y = 0
    for (const tile of tiles) {
      ctx.drawImage(tile, Math.round((width - tile.width) / 2), y)
      y += tile.height
    }
    if (legend) drawLegend(ctx, 0, tilesHeight, width, legendBand, legend)
    return new Promise((resolve) => sheet.toBlob((blob) => resolve(blob), 'image/png'))
  }

  /**
   * Report the label under the crosshair, from whichever pane was clicked, and
   * keep the other pane's crosshair in step.
   */
  onPick(callback: (pick: PickResult) => void): void {
    for (const nv of this.panes) {
      nv.onLocationChange = (location: unknown) => {
        const loc = location as { values?: Array<{ value: number }>; mm?: number[]; vox?: number[] }
        const mm: [number, number, number] = [loc.mm?.[0] ?? 0, loc.mm?.[1] ?? 0, loc.mm?.[2] ?? 0]
        this.syncCrosshair(nv, mm)
        callback({
          value: Math.round(loc.values?.[1]?.value ?? 0),
          mm,
          vox: [loc.vox?.[0] ?? 0, loc.vox?.[1] ?? 0, loc.vox?.[2] ?? 0],
        })
      }
    }
  }

  /** Move the crosshair to a region's representative voxel, in both panes. */
  jumpToRegion(value: number): boolean {
    const atlas = this.nv.volumes[1]
    const centroid = this.centroids.get(value)
    if (!centroid || !atlas) return false

    const mm = atlas.vox2mm(centroid, atlas.matRAS!)
    for (const nv of this.panes) {
      nv.scene.crosshairPos = nv.mm2frac([mm[0], mm[1], mm[2]])
      nv.createOnLocationChange()
      nv.drawScene()
    }
    return true
  }

  /** Mirror a crosshair move into the panes that did not originate it. */
  private syncCrosshair(source: Niivue, mm: [number, number, number]): void {
    for (const nv of this.panes) {
      if (nv === source || nv.volumes.length === 0) continue
      nv.scene.crosshairPos = nv.mm2frac(mm)
      nv.drawScene()
    }
  }

  /**
   * Index the label volume: voxel counts, and a representative voxel per label
   * to jump to. Done once at load so list jumps and size readouts are instant.
   *
   * The representative point is *not* the centre of mass. Most atlas regions
   * are bilateral, so their centroid sits near the midline in a different
   * structure entirely — jumping to it puts the crosshair outside the region
   * the user asked for. Instead we take the centroid, then snap to the nearest
   * voxel that actually carries the label, which is guaranteed to be inside it.
   */
  private indexVoxels(image: NVImage): void {
    this.voxelCounts = new Map()
    this.centroids = new Map()

    // img2RAS() reorders the raw voxels to match dimsRAS, so the indices these
    // loops produce are directly usable with vox2mm(..., matRAS).
    const img = image.img2RAS()
    const [nx, ny, nz] = [image.dimsRAS?.[1] ?? 0, image.dimsRAS?.[2] ?? 0, image.dimsRAS?.[3] ?? 0]
    if (!img || nx === 0) return

    const sums = new Map<number, [number, number, number]>()
    let i = 0
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          const value = Math.round(img[i] as number)
          if (value === 0) continue
          this.voxelCounts.set(value, (this.voxelCounts.get(value) ?? 0) + 1)
          const s = sums.get(value)
          if (s) {
            s[0] += x
            s[1] += y
            s[2] += z
          } else {
            sums.set(value, [x, y, z])
          }
        }
      }
    }

    const centreOfMass = new Map<number, [number, number, number]>()
    for (const [value, sum] of sums) {
      const n = this.voxelCounts.get(value)!
      centreOfMass.set(value, [sum[0] / n, sum[1] / n, sum[2] / n])
    }

    // Second pass: for each label keep the in-region voxel closest to its
    // centre of mass.
    const best = new Map<number, number>()
    i = 0
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          const value = Math.round(img[i] as number)
          if (value === 0) continue
          const com = centreOfMass.get(value)!
          const dx = x - com[0]
          const dy = y - com[1]
          const dz = z - com[2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < (best.get(value) ?? Infinity)) {
            best.set(value, d2)
            this.centroids.set(value, [x, y, z])
          }
        }
      }
    }
  }
}

/**
 * Draw one pane into an offscreen canvas at `scale`× its displayed size, by
 * enlarging the drawing buffer and re-rendering rather than upscaling pixels.
 */
async function renderAtScale(nv: Niivue, scale: number): Promise<HTMLCanvasElement> {
  const canvas = nv.canvas!
  const originalWidth = canvas.width
  const originalHeight = canvas.height
  const out = document.createElement('canvas')

  try {
    canvas.width = Math.round(canvas.clientWidth * scale)
    canvas.height = Math.round(canvas.clientHeight * scale)
    nv.gl.viewport(0, 0, canvas.width, canvas.height)
    nv.drawScene()
    // The buffer is cleared on swap, so read it back in the same frame.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    nv.drawScene()

    out.width = canvas.width
    out.height = canvas.height
    out.getContext('2d')?.drawImage(canvas, 0, 0)
  } finally {
    canvas.width = originalWidth
    canvas.height = originalHeight
    nv.gl.viewport(0, 0, originalWidth, originalHeight)
    nv.drawScene()
  }
  return out
}
