import { LabelParseError, type Region } from '../types.ts'
import type { Parcellation } from '../grayordinates.ts'
import { base64ToBytes, colorFromUnitFloats, inflate, parseXml, typedFromBytes } from './binaryXml.ts'

/**
 * GIFTI label file (`*.label.gii`).
 *
 * Unlike the plain-text formats, a label GIFTI is self-describing: the
 * `<LabelTable>` carries names and colours, and the `<DataArray>` carries one
 * label value per vertex. No sidecar file is needed.
 *
 * Geometry lives in a separate `*.surf.gii`; this reader deliberately returns
 * only the labels and the vertex count they were authored against, so the
 * caller can match them to a surface.
 */
export async function parseGiftiLabel(buffer: ArrayBuffer, filename: string): Promise<Parcellation> {
  const doc = parseXml(new TextDecoder().decode(buffer), 'GIFTI file')

  const regions = readLabelTable(doc)
  const { values, vertexCount } = await readLabelArray(doc)
  const hemisphere = detectHemisphere(doc, filename)

  return {
    table: { regions, format: 'GIFTI label (.label.gii)', warnings: [] },
    surfaces: [{ hemisphere, values, vertexCount }],
    volume: null,
    summary: `${regions.length} regions on ${vertexCount.toLocaleString()} ${hemisphere === 'L' ? 'left' : 'right'} vertices`,
  }
}

function readLabelTable(doc: Document): Region[] {
  const entries = Array.from(doc.querySelectorAll('LabelTable > Label'))
  if (entries.length === 0) throw new LabelParseError('GIFTI file has no <LabelTable>.')

  const regions: Region[] = []
  for (const entry of entries) {
    const value = Number(entry.getAttribute('Key') ?? entry.getAttribute('Index'))
    if (!Number.isFinite(value) || value === 0) continue // 0 is the "???" background
    const name = (entry.textContent ?? '').trim()
    if (name === '' || name === '???') continue
    regions.push({
      value,
      name,
      color: colorFromUnitFloats(entry.getAttribute('Red'), entry.getAttribute('Green'), entry.getAttribute('Blue')),
      colorSynthesised: false,
    })
  }

  if (regions.length === 0) throw new LabelParseError('GIFTI <LabelTable> held no named regions.')
  return regions
}

async function readLabelArray(doc: Document): Promise<{ values: Int32Array; vertexCount: number }> {
  const arrays = Array.from(doc.querySelectorAll('DataArray'))
  const labelArray =
    arrays.find((a) => (a.getAttribute('Intent') ?? '').includes('LABEL')) ?? arrays[0]
  if (!labelArray) throw new LabelParseError('GIFTI file has no <DataArray>.')

  const dataNode = labelArray.querySelector('Data')
  if (!dataNode?.textContent) throw new LabelParseError('GIFTI <DataArray> has no <Data>.')

  const encoding = labelArray.getAttribute('Encoding') ?? 'GZipBase64Binary'
  const dataType = labelArray.getAttribute('DataType') ?? 'NIFTI_TYPE_INT32'
  const vertexCount = Number(labelArray.getAttribute('Dim0'))

  let values: Int32Array
  if (encoding === 'ASCII') {
    values = Int32Array.from(dataNode.textContent.trim().split(/\s+/).map(Number))
  } else {
    let bytes = base64ToBytes(dataNode.textContent)
    if (encoding.startsWith('GZip')) bytes = await inflate(bytes)
    const typed = typedFromBytes(bytes, dataType)
    values = typed instanceof Int32Array ? typed : Int32Array.from(typed)
  }

  if (Number.isFinite(vertexCount) && values.length !== vertexCount) {
    throw new LabelParseError(
      `GIFTI declares ${vertexCount} vertices but decoded ${values.length} values.`,
    )
  }
  return { values, vertexCount: values.length }
}

/**
 * Prefer the file's own metadata; fall back to the `.L.`/`.R.` naming that
 * every HCP-lineage pipeline uses.
 */
function detectHemisphere(doc: Document, filename: string): 'L' | 'R' {
  for (const md of Array.from(doc.querySelectorAll('MD'))) {
    const name = md.querySelector('Name')?.textContent?.trim()
    if (name !== 'AnatomicalStructurePrimary') continue
    const value = (md.querySelector('Value')?.textContent ?? '').toUpperCase()
    if (value.includes('LEFT')) return 'L'
    if (value.includes('RIGHT')) return 'R'
  }
  const structure = (doc.documentElement.getAttribute('AnatomicalStructurePrimary') ?? '').toUpperCase()
  if (structure.includes('LEFT')) return 'L'
  if (structure.includes('RIGHT')) return 'R'

  return /\.R\.|_R\.|\bRH\b|\.rh\./i.test(filename) ? 'R' : 'L'
}
