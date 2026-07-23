import { LabelParseError, type LabelTable, type Region } from '../types.ts'

/**
 * FSL atlas XML (`HarvardOxford-Cortical.xml` and friends):
 *
 *   <label index="0" x="49" y="38" z="37">Frontal Pole</label>
 *
 * The `index` attribute is notoriously *not* the voxel value — for the
 * maxprob images the voxel value is `index + 1`, because 0 is reserved for
 * background. Rather than guess here, the parser records the raw index and
 * lets `reconcileValues()` settle it against the volume that was actually
 * loaded. Some newer files carry an explicit `value` attribute; prefer it.
 */
export function parseFslXml(text: string): LabelTable {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new LabelParseError('File is not well-formed XML.')

  const nodes = Array.from(doc.querySelectorAll('label'))
  if (nodes.length === 0) throw new LabelParseError('No <label> elements found.')

  const warnings: string[] = []
  const regions: Region[] = []
  let usedIndexAttr = false

  for (const node of nodes) {
    const explicit = node.getAttribute('value')
    const raw = explicit ?? node.getAttribute('index')
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      warnings.push(`<label> with index="${raw}" has no usable value — skipped.`)
      continue
    }
    if (explicit === null) usedIndexAttr = true

    const name = (node.textContent ?? '').trim()
    if (name === '') continue

    regions.push({ value, name, color: [128, 128, 128], colorSynthesised: true })
  }

  if (regions.length === 0) throw new LabelParseError('No usable <label> elements found.')
  if (usedIndexAttr) {
    warnings.push(
      'FSL XML stores a 0-based `index`, which is usually one less than the voxel value. ' +
        'The label offset was checked against the volume — see the offset control if names look shifted.',
    )
  }
  return { regions, format: 'FSL atlas XML', warnings }
}
