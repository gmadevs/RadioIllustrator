import dicomParser from 'dicom-parser'

/**
 * Loads DICOM files into series of single-frame grayscale slices.
 *
 * Only uncompressed transfer syntaxes are decoded (implicit and explicit VR
 * little endian, deflated). Encapsulated pixel data (JPEG, JPEG 2000, RLE) is
 * reported per file instead of being guessed at.
 */

/** Tags carried over to the exported Secondary Capture series. */
export const COPIED_TAGS = {
  PatientName: 'x00100010',
  PatientID: 'x00100020',
  PatientBirthDate: 'x00100030',
  PatientSex: 'x00100040',
  StudyInstanceUID: 'x0020000d',
  StudyDate: 'x00080020',
  StudyTime: 'x00080030',
  StudyID: 'x00200010',
  AccessionNumber: 'x00080050',
  StudyDescription: 'x00081030',
  ReferringPhysicianName: 'x00080090',
  Modality: 'x00080060',
  BodyPartExamined: 'x00180015',
  FrameOfReferenceUID: 'x00200052',
  SeriesNumber: 'x00200011',
  SeriesDescription: 'x0008103e',
  InstanceNumber: 'x00200013',
  ImagePositionPatient: 'x00200032',
  ImageOrientationPatient: 'x00200037',
  PixelSpacing: 'x00280030',
  SliceThickness: 'x00180050',
  SliceLocation: 'x00201041',
} as const

export type CopiedTag = keyof typeof COPIED_TAGS

export interface Slice {
  /** Modality values (rescale slope/intercept applied), row-major. */
  pixels: Float32Array
  sortKey: number
  tags: Partial<Record<CopiedTag, string>>
}

export interface Series {
  uid: string
  description: string
  modality: string
  rows: number
  cols: number
  /** Physical size of a pixel, [row spacing, column spacing] in mm, if known. */
  spacing: [number, number] | null
  /** MONOCHROME1: low values are displayed bright. */
  invert: boolean
  window: { center: number; width: number }
  slices: Slice[]
}

export interface LoadResult {
  series: Series[]
  errors: string[]
}

const UNCOMPRESSED = new Set([
  '1.2.840.10008.1.2', // implicit VR little endian
  '1.2.840.10008.1.2.1', // explicit VR little endian
  '1.2.840.10008.1.2.1.99', // deflated explicit VR little endian
])

interface Parsed {
  seriesUid: string
  description: string
  modality: string
  rows: number
  cols: number
  spacing: [number, number] | null
  invert: boolean
  window: { center: number; width: number } | null
  orientation: number[] | null
  position: number[] | null
  instance: number
  tags: Slice['tags']
  frames: Float32Array[]
}

export async function loadFiles(files: File[]): Promise<LoadResult> {
  const errors: string[] = []
  const parsed: Parsed[] = []
  for (const file of files) {
    if (file.name.startsWith('.') || file.name === 'DICOMDIR') continue
    try {
      const p = parseFile(new Uint8Array(await file.arrayBuffer()))
      if (p) parsed.push(p)
    } catch (e) {
      errors.push(`${file.name}: ${(e as Error).message}`)
    }
  }
  return { series: groupSeries(parsed, errors), errors }
}

function parseFile(bytes: Uint8Array): Parsed | null {
  let ds: dicomParser.DataSet
  try {
    ds = dicomParser.parseDicom(bytes)
  } catch {
    throw new Error('not a readable DICOM file')
  }
  const pixelEl = ds.elements.x7fe00010
  if (!pixelEl) return null // SR, presentation state, DICOMDIR...

  const ts = ds.string('x00020010') ?? '1.2.840.10008.1.2'
  if (!UNCOMPRESSED.has(ts) || pixelEl.encapsulatedPixelData) {
    throw new Error(`compressed transfer syntax (${ts}) is not supported: export the series uncompressed from the PACS`)
  }

  const rows = ds.uint16('x00280010') ?? 0
  const cols = ds.uint16('x00280011') ?? 0
  const bits = ds.uint16('x00280100') ?? 16
  const signed = ds.uint16('x00280103') === 1
  const spp = ds.uint16('x00280002') ?? 1
  const planar = ds.uint16('x00280006') ?? 0
  const photometric = (ds.string('x00280004') ?? 'MONOCHROME2').trim()
  const slope = ds.floatString('x00281053') ?? 1
  const intercept = ds.floatString('x00281052') ?? 0
  const nFrames = ds.intString('x00280008') ?? 1
  if (!rows || !cols) throw new Error('image dimensions missing')

  const frameLen = rows * cols * spp * (bits / 8)
  const base = ds.byteArray.byteOffset + pixelEl.dataOffset
  const buf = ds.byteArray.buffer

  // dicom-parser reads text as Latin-1; decode names and descriptions with the
  // file's own character set so they survive being written back as UTF-8.
  const charset = ds.string('x00080005') ?? ''
  const decoder = new TextDecoder(charset.includes('ISO_IR 192') ? 'utf-8' : 'latin1')
  const tags: Slice['tags'] = {}
  for (const [name, tag] of Object.entries(COPIED_TAGS)) {
    const el = ds.elements[tag]
    if (!el || !el.length) continue
    const raw = ds.byteArray.subarray(el.dataOffset, el.dataOffset + el.length)
    const v = decoder.decode(raw).replace(/[\0 ]+$/, '').trim()
    if (v !== '') tags[name as CopiedTag] = v
  }

  const frames: Float32Array[] = []
  for (let f = 0; f < nFrames; f++) {
    const raw = buf.slice(base + f * frameLen, base + (f + 1) * frameLen)
    const n = rows * cols
    const out = new Float32Array(n)
    if (spp === 1) {
      const src =
        bits === 8
          ? signed ? new Int8Array(raw) : new Uint8Array(raw)
          : bits === 16
            ? signed ? new Int16Array(raw) : new Uint16Array(raw)
            : bits === 32
              ? signed ? new Int32Array(raw) : new Uint32Array(raw)
              : null
      if (!src) throw new Error(`BitsAllocated ${bits} is not supported`)
      for (let i = 0; i < n; i++) out[i] = src[i] * slope + intercept
    } else if (spp === 3 && bits === 8) {
      // Colour source (screen captures, fusion): reduce to luminance.
      const src = new Uint8Array(raw)
      for (let i = 0; i < n; i++) {
        const [r, g, b] = planar
          ? [src[i], src[i + n], src[i + 2 * n]]
          : [src[3 * i], src[3 * i + 1], src[3 * i + 2]]
        out[i] = 0.299 * r + 0.587 * g + 0.114 * b
      }
    } else {
      throw new Error(`${spp} samples per pixel at ${bits} bits are not supported`)
    }
    frames.push(out)
  }

  const spacing = numbers(ds.string('x00280030')) ?? numbers(ds.string('x00181164'))
  const wc = ds.floatString('x00281050')
  const ww = ds.floatString('x00281051')
  return {
    seriesUid: ds.string('x0020000e') ?? 'unknown',
    description: ds.string('x0008103e') ?? '',
    modality: ds.string('x00080060') ?? '',
    rows,
    cols,
    spacing: spacing && spacing.length >= 2 ? [spacing[0], spacing[1]] : null,
    invert: photometric === 'MONOCHROME1',
    window: wc !== undefined && ww !== undefined && ww > 0 ? { center: wc, width: ww } : null,
    orientation: numbers(ds.string('x00200037')),
    position: numbers(ds.string('x00200032')),
    instance: ds.intString('x00200013') ?? 0,
    tags,
    frames,
  }
}

function numbers(s: string | undefined): number[] | null {
  if (!s) return null
  const v = s.split('\\').map(Number)
  return v.every(Number.isFinite) ? v : null
}

function groupSeries(parsed: Parsed[], errors: string[]): Series[] {
  const groups = new Map<string, Parsed[]>()
  for (const p of parsed) {
    const g = groups.get(p.seriesUid) ?? []
    g.push(p)
    groups.set(p.seriesUid, g)
  }

  const out: Series[] = []
  for (const [uid, items] of groups) {
    // A series is one matrix size; anything else (a scout in the same series) is dropped.
    const first = items[0]
    const same = items.filter((p) => p.rows === first.rows && p.cols === first.cols)
    if (same.length < items.length) {
      errors.push(`Series ${first.description || uid}: ${items.length - same.length} images with a different size were skipped`)
    }

    // Order along the slice normal; without positions on every image, instance
    // number is the only order there is.
    const normal = sliceNormal(first.orientation)
    const byPosition = normal !== null && same.every((p) => p.position !== null)
    const slices: Slice[] = same.flatMap((p) =>
      p.frames.map((f, i) => ({
        pixels: f,
        tags: p.tags,
        sortKey: byPosition ? dot(normal, p.position!) * 1000 + i : p.instance * 1000 + i,
      })),
    )
    slices.sort((a, b) => a.sortKey - b.sortKey)

    out.push({
      uid,
      description: first.description.trim() || '(no description)',
      modality: first.modality,
      rows: first.rows,
      cols: first.cols,
      spacing: first.spacing,
      invert: first.invert,
      window: first.window ?? autoWindow(slices[Math.floor(slices.length / 2)].pixels),
      slices,
    })
  }
  return out.sort((a, b) => b.slices.length - a.slices.length)
}

function sliceNormal(o: number[] | null): number[] | null {
  if (!o || o.length < 6) return null
  const [a, b, c, d, e, f] = o
  return [b * f - c * e, c * d - a * f, a * e - b * d]
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** 1st–99th percentile window, for series without a stored one. */
export function autoWindow(px: Float32Array): { center: number; width: number } {
  const step = Math.max(1, Math.floor(px.length / 20000))
  const sample: number[] = []
  for (let i = 0; i < px.length; i += step) sample.push(px[i])
  sample.sort((a, b) => a - b)
  const lo = sample[Math.floor(sample.length * 0.01)]
  const hi = sample[Math.floor(sample.length * 0.99)]
  return { center: (lo + hi) / 2, width: Math.max(1, hi - lo) }
}
