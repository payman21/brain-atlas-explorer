import type { LabelTable } from './types.ts'

/** Per-vertex label values for one cortical hemisphere. */
export interface SurfaceLabels {
  hemisphere: 'L' | 'R'
  /** One label value per vertex, length = the surface's vertex count. */
  values: Int32Array
  /** Vertex count the labels were authored against (32492 for fs_LR 32k). */
  vertexCount: number
}

/** A dense label volume reconstructed from CIFTI voxel brain models. */
export interface VolumeLabels {
  dims: [number, number, number]
  /** Row-major i-fastest, matching NIfTI voxel order. */
  data: Int32Array
  /** 4x4 voxel-index → world-mm transform, row-major. */
  affine: number[]
}

/**
 * What a grayordinate file yields: a label table plus any combination of
 * cortical surface labels and a subcortical label volume. A CIFTI dlabel
 * typically has all three; a GIFTI label file has one surface and no volume.
 */
export interface Parcellation {
  table: LabelTable
  surfaces: SurfaceLabels[]
  volume: VolumeLabels | null
  /** Human-readable description of what was found, for the UI. */
  summary: string
}

export function hasSurface(p: Parcellation): boolean {
  return p.surfaces.length > 0
}
