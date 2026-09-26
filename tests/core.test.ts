import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import dicomParser from 'dicom-parser'
import { describe, expect, it } from 'vitest'
import { loadFiles } from '../src/dicom/load'
import { secondaryCapture } from '../src/dicom/write'
import { blend, keyField } from '../src/mask/interpolate'
import { decodeRle, encodeRle, fillPolygon, stroke } from '../src/mask/raster'
import { createStructure, fromProjectFile, maskAt, reinterpolate, toProjectFile } from '../src/model'

const W = 64
const H = 48

function circle(cx: number, cy: number, r: number): Uint8Array {
  const m = new Uint8Array(W * H)
  stroke(m, W, H, [cx, cy], [cx, cy], r, 1)
  return m
}

function centroid(m: Uint8Array): [number, number, number] {
  let sx = 0
  let sy = 0
  let n = 0
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue
    sx += (i % W) + 0.5
    sy += Math.floor(i / W) + 0.5
    n++
  }
  return [sx / n, sy / n, n]
}

describe('masks', () => {
  it('round-trips RLE', () => {
    const m = circle(20, 20, 7)
    expect(decodeRle(encodeRle(m), m.length)).toEqual(m)
    const empty = new Uint8Array(W * H)
    expect(decodeRle(encodeRle(empty), empty.length)).toEqual(empty)
    const full = new Uint8Array(W * H).fill(1)
    expect(decodeRle(encodeRle(full), full.length)).toEqual(full)
  })

  it('fills a polygon by pixel centres', () => {
    const m = new Uint8Array(W * H)
    fillPolygon(m, W, H, [[10, 10], [20, 10], [20, 20], [10, 20]], 1)
    expect(m.reduce((a, b) => a + b, 0)).toBe(100)
    expect(m[10 * W + 10]).toBe(1)
    expect(m[20 * W + 20]).toBe(0)
  })

  it('keeps a key mask unchanged through its own distance field', () => {
    const m = circle(30, 24, 9)
    expect(blend(keyField(m, W, H), keyField(m, W, H), 0.5, W, H)).toEqual(m)
  })

  it('interpolates position and size between two keys', () => {
    const a = circle(16, 24, 6)
    const b = circle(48, 24, 10)
    const mid = blend(keyField(a, W, H), keyField(b, W, H), 0.5, W, H)
    const [cx, cy, n] = centroid(mid)
    expect(cx).toBeCloseTo(32, 0)
    expect(cy).toBeCloseTo(24, 0)
    // Radius ~8: area between the two keys.
    expect(n).toBeGreaterThan(centroid(a)[2])
    expect(n).toBeLessThan(centroid(b)[2])
  })

  it('fades out towards an empty key', () => {
    const a = circle(20, 24, 8)
    const empty = new Uint8Array(W * H)
    const near = centroid(blend(keyField(a, W, H), keyField(empty, W, H), 0.25, W, H))[2]
    const far = centroid(blend(keyField(a, W, H), keyField(empty, W, H), 0.75, W, H))[2]
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
  })

  it('fills only the slices between keys and prefers keys', () => {
    const s = createStructure('Spinal canal', '#ff0000')
    s.keys.set(2, circle(16, 24, 6))
    s.keys.set(6, circle(40, 24, 6))
    reinterpolate(s, W, H)
    expect([...s.filled.keys()].sort()).toEqual([3, 4, 5])
    expect(maskAt(s, 1)).toBeUndefined()
    expect(maskAt(s, 2)).toBe(s.keys.get(2))
    s.interpolate = false
    expect(maskAt(s, 4)).toBeUndefined()
  })

  it('round-trips a project file', () => {
    const s = createStructure('Spinal cord', '#00ff00')
    s.keys.set(0, circle(20, 20, 5))
    s.keys.set(3, circle(30, 20, 5))
    const p = JSON.parse(JSON.stringify(toProjectFile('1.2.3', H, W, 5, [s])))
    const [back] = fromProjectFile(p)
    expect(back.name).toBe('Spinal cord')
    expect(back.keys.get(3)).toEqual(s.keys.get(3))
    expect(back.filled.size).toBe(2)
  })
})

describe('DICOM', () => {
  it('writes a Secondary Capture that parses back', () => {
    const w = 4
    const h = 3
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) data.set([i, 100, 200, 255], i * 4)
    const bytes = secondaryCapture(
      {
        pixels: new Float32Array(w * h),
        sortKey: 0,
        tags: {
          PatientName: 'Anon^Test',
          StudyInstanceUID: '1.2.3.4',
          Modality: 'MR',
          PixelSpacing: '0.5\\0.5',
          ImagePositionPatient: '0\\0\\12.5',
        },
      },
      { width: w, height: h, data, colorSpace: 'srgb' } as ImageData,
      { seriesUid: '1.2.3.4.5', seriesNumber: 9001, seriesDescription: 'T2 — canal', instanceNumber: 7, scale: 2 },
    )
    const ds = dicomParser.parseDicom(bytes)
    expect(ds.string('x00020010')).toBe('1.2.840.10008.1.2.1')
    expect(ds.string('x00080016')).toBe('1.2.840.10008.5.1.4.1.1.7')
    expect(ds.string('x0020000d')).toBe('1.2.3.4')
    expect(ds.string('x0020000e')).toBe('1.2.3.4.5')
    expect(ds.string('x00100010')).toBe('Anon^Test')
    expect(ds.string('x00080060')).toBe('MR')
    expect(ds.string('x00280030')).toBe('0.25\\0.25')
    expect(ds.string('x00200013')).toBe('7')
    expect(ds.string('x00080005')).toBe('ISO_IR 192')
    const desc = ds.elements.x0008103e
    expect(new TextDecoder().decode(bytes.subarray(desc.dataOffset, desc.dataOffset + desc.length)).trim()).toBe('T2 — canal')
    expect(ds.string('x00280004')).toBe('RGB')
    expect(ds.uint16('x00280010')).toBe(h)
    expect(ds.uint16('x00280011')).toBe(w)
    const px = ds.elements.x7fe00010
    expect(px.length).toBe(w * h * 3)
    const rgb = bytes.slice(px.dataOffset, px.dataOffset + px.length)
    expect([...rgb.slice(3 * 5, 3 * 5 + 3)]).toEqual([5, 100, 200])
    // SOP instance UID in the meta header matches the dataset.
    expect(ds.string('x00020003')).toBe(ds.string('x00080018'))
  })

  const sampleDir = join(homedir(), 'radiouploader-sample')
  it.skipIf(!existsSync(sampleDir))('loads the local sample series', async () => {
    const files = readdirSync(sampleDir)
      .filter((f) => f.endsWith('.dcm'))
      .map((f) => new File([readFileSync(join(sampleDir, f))], f))
    const { series, errors } = await loadFiles(files)
    expect(series.length).toBeGreaterThan(0)
    for (const s of series) {
      expect(s.slices.every((sl) => sl.pixels.length === s.rows * s.cols)).toBe(true)
      expect(s.window.width).toBeGreaterThan(0)
    }
    console.log(series.map((s) => `${s.modality} ${s.description} ${s.cols}x${s.rows} x${s.slices.length}`), errors)
  })
})
