import { LabelParseError, type Region } from '../types.ts'
import type { Parcellation, SurfaceLabels } from '../grayordinates.ts'
import { colorFromUnitFloats, gunzip, isGzip, parseIntList, parseXml } from './binaryXml.ts'

/**
 * CIFTI-2 dense label file (`*.dlabel.nii`).
 *
 * The container is a NIfTI-2 file whose header extension holds CIFTI XML; the
 * image data is a flat array of grayordinates. The XML says how that flat array
 * maps onto cortical surface vertices and subcortical voxels, and carries the
 * label table.
 *
 * NiiVue cannot do this itself: its CIFTI path treats the data as scalar
 * overlays for an already-loaded cortical mesh, skips every non-surface brain
 * model, and ignores the label table entirely.
 */

const NIFTI2_HEADER_SIZE = 540
const CIFTI_ECODE = 32

export async function parseCiftiDlabel(rawBuffer: ArrayBuffer): Promise<Parcellation> {
  const raw = new Uint8Array(rawBuffer)
  const bytes = isGzip(raw) ? await gunzip(raw) : raw

  const header = readNifti2Header(bytes)
  const xml = readCiftiXml(bytes, header)
  const doc = parseXml(xml, 'CIFTI extension')

  const allRegions = readLabelTable(doc)
  const data = readData(bytes, header)
  const { surfaces, subcorticalValues, warnings } = readBrainModels(doc, data)

  if (surfaces.length === 0) {
    throw new LabelParseError(
      'CIFTI file declares no cortical surface models. Only the surface half of a CIFTI file is shown here; ' +
        'load a labelled NIfTI to explore volumetric parcellations.',
    )
  }

  // Grayordinate files mix cortical vertices with subcortical voxels. The
  // subcortical structures belong to the volumetric path, so they are dropped
  // here rather than half-rendered — the region list would otherwise be full of
  // entries that no surface can ever show.
  const onSurface = new Set<number>()
  for (const surface of surfaces) for (const value of surface.values) if (value !== 0) onSurface.add(value)

  const regions = allRegions.filter((r) => onSurface.has(r.value))
  const dropped = allRegions.length - regions.length
  if (dropped > 0) {
    warnings.push(
      `${dropped} subcortical region(s) in this file are stored as voxels, not surface vertices, and were left out ` +
        `of the surface view. Load the matching volumetric atlas to explore them.`,
    )
  }
  if (subcorticalValues > 0 && dropped === 0) {
    warnings.push(`${subcorticalValues} subcortical voxel model(s) were skipped.`)
  }

  const parts = surfaces.map((s) => `${s.vertexCount.toLocaleString()} ${s.hemisphere} vertices`)
  return {
    table: { regions, format: 'CIFTI-2 dense label (.dlabel.nii)', warnings },
    surfaces,
    volume: null,
    summary: `${regions.length} cortical regions across ${parts.join(' + ')}`,
  }
}

// ------------------------------------------------------------------ NIfTI-2

interface Nifti2Header {
  littleEndian: boolean
  dims: number[]
  datatype: number
  voxOffset: number
}

function readNifti2Header(bytes: Uint8Array): Nifti2Header {
  if (bytes.length < NIFTI2_HEADER_SIZE) throw new LabelParseError('File is too small to be a CIFTI-2 file.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // sizeof_hdr is 540 for NIfTI-2; reading it both ways reveals the endianness.
  let littleEndian = true
  let sizeofHdr = view.getInt32(0, true)
  if (sizeofHdr !== NIFTI2_HEADER_SIZE) {
    littleEndian = false
    sizeofHdr = view.getInt32(0, false)
  }
  if (sizeofHdr !== NIFTI2_HEADER_SIZE) {
    throw new LabelParseError(
      'Not a NIfTI-2 file. CIFTI files are NIfTI-2; a NIfTI-1 volume should be loaded as a plain parcellation instead.',
    )
  }

  const magic = String.fromCharCode(...bytes.slice(4, 8)).replace(/\0/g, '')
  if (magic !== 'n+2' && magic !== 'ni2') {
    throw new LabelParseError(`Unexpected NIfTI-2 magic "${magic}".`)
  }

  const datatype = view.getInt16(12, littleEndian)
  // NIfTI-2 stores dim[] as 8 int64 values at offset 16.
  const dims: number[] = []
  for (let i = 0; i < 8; i++) dims.push(Number(view.getBigInt64(16 + i * 8, littleEndian)))
  const voxOffset = Number(view.getBigInt64(168, littleEndian))

  return { littleEndian, dims, datatype, voxOffset }
}

function readCiftiXml(bytes: Uint8Array, header: Nifti2Header): string {
  // The extender flag sits immediately after the 540-byte header.
  if (bytes[NIFTI2_HEADER_SIZE] === 0) throw new LabelParseError('CIFTI file has no header extension.')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = NIFTI2_HEADER_SIZE + 4

  while (pos + 8 <= header.voxOffset && pos + 8 <= bytes.length) {
    const esize = view.getInt32(pos, header.littleEndian)
    const ecode = view.getInt32(pos + 4, header.littleEndian)
    if (esize <= 8) break

    if (ecode === CIFTI_ECODE) {
      const raw = bytes.slice(pos + 8, pos + esize)
      return new TextDecoder().decode(raw).replace(/\0+$/, '')
    }
    pos += esize
  }
  throw new LabelParseError('No CIFTI XML extension (ecode 32) found in the file.')
}

function readData(bytes: Uint8Array, header: Nifti2Header): Float32Array {
  const total = header.dims[5] > 0 ? header.dims[6] || header.dims[5] : header.dims[1]
  const count = Number.isFinite(total) && total > 0 ? total : 0
  const start = header.voxOffset

  const slice = bytes.slice(start)
  const aligned = new Uint8Array(slice)
  const buf = aligned.buffer

  // dlabel files are written as float32 or int32; both decode to label numbers.
  switch (header.datatype) {
    case 16: // DT_FLOAT32
      return new Float32Array(buf, 0, count || undefined)
    case 8: // DT_INT32
      return Float32Array.from(new Int32Array(buf, 0, count || undefined))
    case 4: // DT_INT16
      return Float32Array.from(new Int16Array(buf, 0, count || undefined))
    case 2: // DT_UINT8
      return Float32Array.from(new Uint8Array(buf, 0, count || undefined))
    default:
      throw new LabelParseError(`Unsupported CIFTI datatype code ${header.datatype}.`)
  }
}

// -------------------------------------------------------------- CIFTI XML

function readLabelTable(doc: Document): Region[] {
  const entries = Array.from(doc.querySelectorAll('LabelTable > Label'))
  if (entries.length === 0) throw new LabelParseError('CIFTI XML has no <LabelTable>.')

  const regions: Region[] = []
  const seen = new Set<number>()
  for (const entry of entries) {
    const value = Number(entry.getAttribute('Key'))
    if (!Number.isFinite(value) || value === 0 || seen.has(value)) continue
    const name = (entry.textContent ?? '').trim()
    if (name === '' || name === '???') continue
    seen.add(value)
    regions.push({
      value,
      name,
      color: colorFromUnitFloats(entry.getAttribute('Red'), entry.getAttribute('Green'), entry.getAttribute('Blue')),
      colorSynthesised: false,
    })
  }

  if (regions.length === 0) throw new LabelParseError('CIFTI <LabelTable> held no named regions.')
  return regions
}

interface BrainModelResult {
  surfaces: SurfaceLabels[]
  /** Count of voxel brain models seen, so the caller can mention them. */
  subcorticalValues: number
  warnings: string[]
}

/**
 * Scatter the flat grayordinate array back onto cortical surfaces.
 *
 * Surface models are sparse — the medial wall is excluded — so vertices absent
 * from `VertexIndices` keep label 0 and render as unlabelled cortex.
 */
function readBrainModels(doc: Document, data: Float32Array): BrainModelResult {
  const warnings: string[] = []
  const surfaces: SurfaceLabels[] = []
  let subcorticalValues = 0

  for (const model of Array.from(doc.querySelectorAll('BrainModel'))) {
    const offset = Number(model.getAttribute('IndexOffset'))
    const count = Number(model.getAttribute('IndexCount'))
    const type = model.getAttribute('ModelType') ?? ''
    const structure = (model.getAttribute('BrainStructure') ?? '').toUpperCase()
    if (!Number.isFinite(offset) || !Number.isFinite(count)) continue

    if (type.includes('VOXELS')) {
      subcorticalValues++
      continue
    }
    if (!type.includes('SURFACE') || !structure.includes('CORTEX')) continue

    const vertexCount = Number(model.getAttribute('SurfaceNumberOfVertices'))
    const indices = parseIntList(model.querySelector('VertexIndices')?.textContent)
    const hemisphere: 'L' | 'R' = structure.includes('RIGHT') ? 'R' : 'L'

    const values = new Int32Array(vertexCount)
    for (let i = 0; i < indices.length && i < count; i++) {
      values[indices[i]] = Math.round(data[offset + i])
    }
    surfaces.push({ hemisphere, values, vertexCount })
  }

  return { surfaces, subcorticalValues, warnings }
}
