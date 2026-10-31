// ui/src/ipc/images.ts
// Width buckets and URL builders for the `ftimg` image protocol (ARCHITECTURE.md §6).
// Face-centred day cells crop with `faceCellStyle` (features/days/daysModel.ts).
import {
  ALIGNED_WIDTHS,
  PREVIEW_WIDTHS,
  REFERENCE_FRAME_WIDTHS,
  REFERENCE_WIDTHS,
  THUMB_WIDTHS,
  imageUrl,
  type PhotoId,
  type Version,
} from './contract'

/** Absorbs float noise such as 106.67 × 3 = 320.01 when matching a bucket. */
const BUCKET_EPSILON = 1e-6

/** Photo reference for the thumb route. */
export interface ThumbRef {
  readonly id: PhotoId
  readonly version: Version
}

/** Frame reference for the aligned route (FrameSummary / AlignRecent shape). */
export interface AlignedRef {
  readonly photoId: PhotoId
  readonly version: Version
}

/** Smallest bucket ≥ cssWidth × dpr (the largest bucket when bigger); `widths` ascending. */
export function bucketWidth(widths: readonly number[], cssWidth: number, dpr: number): number {
  const smallest = widths[0]
  const largest = widths[widths.length - 1]
  if (smallest === undefined || largest === undefined) throw new RangeError('No width buckets')
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const needed = cssWidth * ratio
  if (!Number.isFinite(needed) || needed <= 0) return smallest
  return widths.find((w) => w + BUCKET_EPSILON >= needed) ?? largest
}

/** `thumb/{id}` URL for an element `cssWidth` CSS px wide. */
export function thumbUrl(base: string, photo: ThumbRef, cssWidth: number, dpr: number): string {
  const width = bucketWidth(THUMB_WIDTHS, cssWidth, dpr)
  return imageUrl(base, { kind: 'thumb', photoId: photo.id, version: photo.version, width })
}

/** `aligned/{id}` URL; pass `cssWidth: null` only to request the full master frame. */
export function alignedUrl(base: string, frame: AlignedRef, cssWidth: number | null, dpr: number): string {
  const width = cssWidth === null ? null : bucketWidth(ALIGNED_WIDTHS, cssWidth, dpr)
  return imageUrl(base, { kind: 'aligned', photoId: frame.photoId, version: frame.version, width })
}

/** v1.7 `preview/{id}`: the aligned frame the photo would get now, rendered on demand (`version` = `PhotoDetail.previewVersion`). */
export function previewUrl(base: string, photoId: PhotoId, version: Version, cssWidth: number, dpr: number): string {
  return imageUrl(base, { kind: 'preview', photoId, version, width: bucketWidth(PREVIEW_WIDTHS, cssWidth, dpr) })
}

/** `reference` (whole rotated reference image) URL. */
export function referenceUrl(base: string, version: Version, cssWidth: number, dpr: number): string {
  return imageUrl(base, { kind: 'reference', version, width: bucketWidth(REFERENCE_WIDTHS, cssWidth, dpr) })
}

/** `reference/frame` (reference crop at output aspect) URL. */
export function referenceFrameUrl(base: string, version: Version, cssWidth: number, dpr: number): string {
  return imageUrl(base, { kind: 'referenceFrame', version, width: bucketWidth(REFERENCE_FRAME_WIDTHS, cssWidth, dpr) })
}
