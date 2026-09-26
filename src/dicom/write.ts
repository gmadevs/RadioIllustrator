import type { CopiedTag, Slice } from './load'

/**
 * Writes one annotated slice as an RGB Secondary Capture image, explicit VR
 * little endian. Study-level tags come from the source slice so the file lands
 * in the same study; series and instance UIDs are new, so the annotated stack
 * is a separate series next to the original.
 */

const SC_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.7'
const EXPLICIT_LE = '1.2.840.10008.1.2.1'
const IMPLEMENTATION_UID = '2.25.198712410985127613546913290541879236118'

type Vr = 'AE' | 'CS' | 'DA' | 'DS' | 'IS' | 'LO' | 'OB' | 'PN' | 'SH' | 'TM' | 'UI' | 'US' | 'UL' | 'ST'

const COPIED_VR: Record<CopiedTag, [number, number, Vr]> = {
  PatientName: [0x0010, 0x0010, 'PN'],
  PatientID: [0x0010, 0x0020, 'LO'],
  PatientBirthDate: [0x0010, 0x0030, 'DA'],
  PatientSex: [0x0010, 0x0040, 'CS'],
  StudyInstanceUID: [0x0020, 0x000d, 'UI'],
  StudyDate: [0x0008, 0x0020, 'DA'],
  StudyTime: [0x0008, 0x0030, 'TM'],
  StudyID: [0x0020, 0x0010, 'SH'],
  AccessionNumber: [0x0008, 0x0050, 'SH'],
  StudyDescription: [0x0008, 0x1030, 'LO'],
  ReferringPhysicianName: [0x0008, 0x0090, 'PN'],
  Modality: [0x0008, 0x0060, 'CS'],
  BodyPartExamined: [0x0018, 0x0015, 'CS'],
  FrameOfReferenceUID: [0x0020, 0x0052, 'UI'],
  SeriesNumber: [0x0020, 0x0011, 'IS'],
  SeriesDescription: [0x0008, 0x103e, 'LO'],
  InstanceNumber: [0x0020, 0x0013, 'IS'],
  ImagePositionPatient: [0x0020, 0x0032, 'DS'],
  ImageOrientationPatient: [0x0020, 0x0037, 'DS'],
  PixelSpacing: [0x0028, 0x0030, 'DS'],
  SliceThickness: [0x0018, 0x0050, 'DS'],
  SliceLocation: [0x0020, 0x1041, 'DS'],
}

interface Element {
  group: number
  element: number
  vr: Vr
  value: Uint8Array
}

export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return `2.25.${n}`
}

export interface ScOptions {
  seriesUid: string
  seriesNumber: number
  seriesDescription: string
  instanceNumber: number
  /** Output pixels per source pixel; pixel spacing is divided by it. */
  scale: number
}

export function secondaryCapture(source: Slice, rgba: ImageData, opts: ScOptions): Uint8Array {
  const sopUid = newUid()
  const tags: Partial<Record<CopiedTag, string>> = { ...source.tags }
  tags.SeriesNumber = String(opts.seriesNumber)
  tags.SeriesDescription = opts.seriesDescription
  tags.InstanceNumber = String(opts.instanceNumber)
  if (tags.PixelSpacing && opts.scale !== 1) {
    tags.PixelSpacing = tags.PixelSpacing.split('\\')
      .map((v) => fmtDs(Number(v) / opts.scale))
      .join('\\')
  }
  tags.Modality ??= 'OT'
  tags.PatientName ??= ''
  tags.PatientID ??= ''
  tags.StudyInstanceUID ??= newUid()

  const now = new Date()
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

  const rgb = new Uint8Array(rgba.width * rgba.height * 3)
  for (let i = 0, j = 0; i < rgba.data.length; i += 4, j += 3) {
    rgb[j] = rgba.data[i]
    rgb[j + 1] = rgba.data[i + 1]
    rgb[j + 2] = rgba.data[i + 2]
  }

  const els: Element[] = [
    str(0x0008, 0x0005, 'CS', 'ISO_IR 192'),
    str(0x0008, 0x0008, 'CS', 'DERIVED\\SECONDARY'),
    str(0x0008, 0x0012, 'DA', date),
    str(0x0008, 0x0013, 'TM', time),
    str(0x0008, 0x0016, 'UI', SC_SOP_CLASS),
    str(0x0008, 0x0018, 'UI', sopUid),
    str(0x0008, 0x0064, 'CS', 'WSD'),
    str(0x0008, 0x2111, 'ST', 'Annotated with RadioIllustrator'),
    str(0x0020, 0x000e, 'UI', opts.seriesUid),
    us(0x0028, 0x0002, 3),
    str(0x0028, 0x0004, 'CS', 'RGB'),
    us(0x0028, 0x0006, 0),
    us(0x0028, 0x0010, rgba.height),
    us(0x0028, 0x0011, rgba.width),
    us(0x0028, 0x0100, 8),
    us(0x0028, 0x0101, 8),
    us(0x0028, 0x0102, 7),
    us(0x0028, 0x0103, 0),
    { group: 0x7fe0, element: 0x0010, vr: 'OB', value: rgb },
  ]
  for (const [name, value] of Object.entries(tags)) {
    const [g, e, vr] = COPIED_VR[name as CopiedTag]
    els.push(str(g, e, vr, value))
  }
  els.sort((a, b) => a.group - b.group || a.element - b.element)

  const meta: Element[] = [
    { group: 0x0002, element: 0x0001, vr: 'OB', value: new Uint8Array([0, 1]) },
    str(0x0002, 0x0002, 'UI', SC_SOP_CLASS),
    str(0x0002, 0x0003, 'UI', sopUid),
    str(0x0002, 0x0010, 'UI', EXPLICIT_LE),
    str(0x0002, 0x0012, 'UI', IMPLEMENTATION_UID),
    str(0x0002, 0x0013, 'SH', 'RADIOILLUSTR01'),
  ]
  const metaBody = concat(meta.map(encode))
  const groupLength = encode({ group: 0x0002, element: 0x0000, vr: 'UL', value: u32(metaBody.length) })

  const preamble = new Uint8Array(132)
  preamble.set([0x44, 0x49, 0x43, 0x4d], 128) // "DICM"
  return concat([preamble, groupLength, metaBody, ...els.map(encode)])
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** DS values are at most 16 characters. */
function fmtDs(v: number): string {
  let s = String(Number(v.toPrecision(10)))
  if (s.length > 16) s = v.toExponential(8)
  return s
}

function str(group: number, element: number, vr: Vr, value: string): Element {
  let bytes = new TextEncoder().encode(value)
  if (bytes.length % 2) {
    const padded = new Uint8Array(bytes.length + 1)
    padded.set(bytes)
    padded[bytes.length] = vr === 'UI' ? 0x00 : 0x20
    bytes = padded
  }
  return { group, element, vr, value: bytes }
}

function us(group: number, element: number, v: number): Element {
  return { group, element, vr: 'US', value: new Uint8Array(new Uint16Array([v]).buffer) }
}

function u32(v: number): Uint8Array {
  return new Uint8Array(new Uint32Array([v]).buffer)
}

function encode(el: Element): Uint8Array {
  let value = el.value
  if (value.length % 2) {
    const padded = new Uint8Array(value.length + 1)
    padded.set(value)
    value = padded
  }
  const long = el.vr === 'OB'
  const head = new Uint8Array(long ? 12 : 8)
  const dv = new DataView(head.buffer)
  dv.setUint16(0, el.group, true)
  dv.setUint16(2, el.element, true)
  head[4] = el.vr.charCodeAt(0)
  head[5] = el.vr.charCodeAt(1)
  if (long) dv.setUint32(8, value.length, true)
  else dv.setUint16(6, value.length, true)
  return concat([head, value])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
