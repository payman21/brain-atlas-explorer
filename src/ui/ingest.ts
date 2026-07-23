/**
 * Routes dropped/selected files into the two things the app can consume:
 * a parcellation volume and a label table. Everything stays in the browser —
 * nothing is uploaded anywhere.
 */

export interface SortedFiles {
  /** A single-file NIfTI, or the `.hdr` of a two-file NIfTI/Analyze pair. */
  volume: File | null
  /** The `.img` half of a two-file pair, paired with `volume`. */
  volumeImage: File | null
  /** A sidecar label table (dseg.tsv, LUT, XML, JSON…). */
  labels: File | null
  /** A CIFTI dense label file — self-describing, cortex plus subcortex. */
  cifti: File | null
  /** GIFTI label files, up to one per hemisphere. */
  gifti: File[]
  /** Surface geometry supplied by the user, overriding the bundled meshes. */
  surfaces: File[]
  /** A `.hdr` or `.img` dropped without its partner. */
  incompletePair: string[]
  ignored: string[]
}

// Order matters: the CIFTI and GIFTI tests must run before the generic
// volume/label tests, since `.dlabel.nii` also matches the NIfTI pattern and
// `.label.gii` also matches the mesh pattern.
const CIFTI_RE = /\.(dlabel|dscalar|dtseries|plabel|ptseries)\.nii(\.gz)?$/i
const GIFTI_LABEL_RE = /\.label\.gii$/i
const SURFACE_RE = /\.surf\.gii$|\.(inflated|midthickness|pial|white|sphere)$/i
const NIFTI_RE = /\.(nii|nii\.gz|mgz|mgh)$/i
const HDR_RE = /\.hdr$/i
const IMG_RE = /\.img$/i
const LABEL_RE = /\.(tsv|csv|txt|json|xml|lut|label|ctbl)$/i

export function sortFiles(files: File[]): SortedFiles {
  const sorted: SortedFiles = {
    volume: null,
    volumeImage: null,
    labels: null,
    cifti: null,
    gifti: [],
    surfaces: [],
    incompletePair: [],
    ignored: [],
  }

  // Analyze / two-file NIfTI arrives as a .hdr + .img pair that must be loaded
  // together, so they are collected and matched by basename after the sweep.
  const headers: File[] = []
  const images: File[] = []

  for (const file of files) {
    const name = file.name.toLowerCase()

    if (CIFTI_RE.test(name)) {
      if (!sorted.cifti) sorted.cifti = file
      else sorted.ignored.push(file.name)
    } else if (GIFTI_LABEL_RE.test(name)) {
      if (sorted.gifti.length < 2) sorted.gifti.push(file)
      else sorted.ignored.push(file.name)
    } else if (SURFACE_RE.test(name)) {
      if (sorted.surfaces.length < 2) sorted.surfaces.push(file)
      else sorted.ignored.push(file.name)
    } else if (HDR_RE.test(name)) {
      headers.push(file)
    } else if (IMG_RE.test(name)) {
      images.push(file)
    } else if (NIFTI_RE.test(name) || name.endsWith('.gz')) {
      if (!sorted.volume) sorted.volume = file
      else sorted.ignored.push(file.name)
    } else if (LABEL_RE.test(name)) {
      if (!sorted.labels) sorted.labels = file
      else sorted.ignored.push(file.name)
    } else {
      sorted.ignored.push(file.name)
    }
  }

  pairHeaderImage(headers, images, sorted)
  return sorted
}

/** Match `.hdr` to `.img` by basename; report any half left without a partner. */
function pairHeaderImage(headers: File[], images: File[], sorted: SortedFiles): void {
  const stem = (f: File) => f.name.toLowerCase().replace(/\.(hdr|img)$/, '')
  const imageByStem = new Map(images.map((f) => [stem(f), f]))
  const usedImages = new Set<File>()

  for (const header of headers) {
    const image = imageByStem.get(stem(header))
    if (image && !sorted.volume) {
      // A single-file NIfTI, if also present, already claimed `volume`; the
      // pair only fills in when nothing else has.
      sorted.volume = header
      sorted.volumeImage = image
      usedImages.add(image)
    } else if (image) {
      usedImages.add(image)
      sorted.ignored.push(header.name, image.name)
    } else {
      sorted.incompletePair.push(header.name)
    }
  }
  for (const image of images) {
    if (!usedImages.has(image)) sorted.incompletePair.push(image.name)
  }
}

/** Guess a hemisphere from the HCP-style `.L.` / `.R.` naming convention. */
export function hemisphereOf(filename: string): 'L' | 'R' {
  return /\.R\.|_R\.|\.rh\.|\bRH\b|right/i.test(filename) ? 'R' : 'L'
}

export function attachDropzone(zone: HTMLElement, onFiles: (files: File[]) => void): void {
  const stop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  for (const type of ['dragenter', 'dragover'] as const) {
    zone.addEventListener(type, (e) => {
      stop(e)
      zone.classList.add('dragover')
    })
  }
  for (const type of ['dragleave', 'drop'] as const) {
    zone.addEventListener(type, (e) => {
      stop(e)
      zone.classList.remove('dragover')
    })
  }

  zone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) onFiles(files)
  })

  // Dropping onto the viewer should work too, not just the small target.
  for (const type of ['dragover', 'drop'] as const) {
    document.body.addEventListener(type, (e) => {
      if (zone.contains(e.target as Node)) return
      stop(e)
      if (type === 'drop') {
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (files.length) onFiles(files)
      }
    })
  }
}
