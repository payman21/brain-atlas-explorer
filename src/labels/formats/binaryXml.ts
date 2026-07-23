/**
 * Shared decoding helpers for GIFTI and CIFTI, which both embed numeric arrays
 * as base64 inside XML and both describe colours as floats in 0…1.
 */

import type { RGB } from '../types.ts'

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * GIFTI's "GZipBase64Binary" is zlib-wrapped deflate in practice, but files
 * written by some tools carry a real gzip header. Try both before giving up.
 */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const formats: CompressionFormat[] = bytes[0] === 0x1f && bytes[1] === 0x8b ? ['gzip', 'deflate'] : ['deflate', 'gzip']
  let lastError: unknown
  for (const format of formats) {
    try {
      return await decompress(bytes, format)
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`Could not decompress embedded data: ${String(lastError)}`)
}

async function decompress(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return decompress(bytes, 'gzip')
}

/** Reinterpret raw bytes as the numeric type named by a GIFTI/NIfTI datatype. */
export function typedFromBytes(bytes: Uint8Array, dataType: string): Int32Array | Float32Array | Uint8Array {
  // Copy into an aligned buffer: the byte offset from a decompressed stream is
  // not guaranteed to be a multiple of 4.
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes)
  const buf = aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength)

  if (dataType.includes('INT32') || dataType.includes('UINT32')) return new Int32Array(buf)
  if (dataType.includes('FLOAT32')) return new Float32Array(buf)
  if (dataType.includes('UINT8') || dataType.includes('INT8')) return new Uint8Array(buf)
  if (dataType.includes('INT16') || dataType.includes('UINT16')) {
    return Int32Array.from(new Int16Array(buf))
  }
  throw new Error(`Unsupported data type "${dataType}".`)
}

/** GIFTI and CIFTI both write colour channels as floats in 0…1. */
export function colorFromUnitFloats(r: string | null, g: string | null, b: string | null): RGB {
  const chan = (v: string | null) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 128
    // Tolerate files that (incorrectly) store 0…255.
    return Math.round(n <= 1 ? n * 255 : n)
  }
  return [chan(r), chan(g), chan(b)]
}

export function parseXml(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const error = doc.querySelector('parsererror')
  if (error) throw new Error(`${what} contains malformed XML: ${error.textContent?.slice(0, 120)}`)
  return doc
}

/** Whitespace-separated integers, as written in CIFTI index elements. */
export function parseIntList(text: string | null | undefined): Int32Array {
  if (!text) return new Int32Array(0)
  const trimmed = text.trim()
  if (trimmed === '') return new Int32Array(0)
  const parts = trimmed.split(/\s+/)
  const out = new Int32Array(parts.length)
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i])
  return out
}
