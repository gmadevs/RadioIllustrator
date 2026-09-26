import type { Series } from './dicom/load'
import { maskAt, type Structure } from './model'

/** Compositing shared by the viewer and the export, so what you see is what you export. */

export interface WindowLevel {
  center: number
  width: number
}

export function grayImage(series: Series, slice: number, wl: WindowLevel): ImageData {
  const { rows, cols } = series
  const px = series.slices[slice].pixels
  const img = new ImageData(cols, rows)
  const lo = wl.center - wl.width / 2
  const k = 255 / wl.width
  const d = img.data
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    let v = (px[i] - lo) * k
    v = v < 0 ? 0 : v > 255 ? 255 : v
    if (series.invert) v = 255 - v
    d[j] = d[j + 1] = d[j + 2] = v
    d[j + 3] = 255
  }
  return img
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Coloured overlay for one slice: translucent fill plus an opaque one-pixel outline. */
export function overlayImage(structures: Structure[], slice: number, w: number, h: number): ImageData | null {
  const layers = structures
    .filter((s) => s.visible)
    .map((s) => ({ s, m: maskAt(s, slice) }))
    .filter((l): l is { s: Structure; m: Uint8Array } => l.m !== undefined)
  if (!layers.length) return null

  const img = new ImageData(w, h)
  const d = img.data
  for (const { s, m } of layers) {
    const [r, g, b] = hexToRgb(s.color)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (!m[i]) continue
        const edge =
          s.outline &&
          (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !m[i - 1] || !m[i + 1] || !m[i - w] || !m[i + w])
        const a = edge ? 1 : s.opacity
        // "source over" onto whatever earlier structures left here.
        const j = i * 4
        const da = d[j + 3] / 255
        const oa = a + da * (1 - a)
        if (oa === 0) continue
        d[j] = (r * a + d[j] * da * (1 - a)) / oa
        d[j + 1] = (g * a + d[j + 1] * da * (1 - a)) / oa
        d[j + 2] = (b * a + d[j + 2] * da * (1 - a)) / oa
        d[j + 3] = oa * 255
      }
    }
  }
  return img
}

/** Structures that have a mask on at least one slice. */
export function annotated(structures: Structure[]): Structure[] {
  return structures.filter((s) => s.visible && s.keys.size > 0)
}

/** Colour key in the bottom-left corner, sized relative to the image. */
export function drawLegend(ctx: CanvasRenderingContext2D, structures: Structure[], w: number, h: number): void {
  const items = annotated(structures)
  if (!items.length) return
  const font = Math.max(11, Math.round(Math.min(w, h) * 0.032))
  const pad = Math.round(font * 0.6)
  const sw = Math.round(font * 0.9)
  ctx.save()
  ctx.font = `600 ${font}px -apple-system, "Helvetica Neue", Arial, sans-serif`
  ctx.textBaseline = 'middle'
  const lineH = Math.round(font * 1.4)
  const textW = Math.max(...items.map((s) => ctx.measureText(s.name).width))
  const boxW = pad * 3 + sw + textW
  const boxH = pad * 2 + lineH * items.length - (lineH - font)
  const x0 = pad
  const y0 = h - pad - boxH
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(x0, y0, boxW, boxH)
  items.forEach((s, i) => {
    const cy = y0 + pad + font / 2 + i * lineH
    ctx.fillStyle = s.color
    ctx.fillRect(x0 + pad, cy - sw / 2, sw, sw)
    ctx.fillStyle = '#fff'
    ctx.fillText(s.name, x0 + pad * 2 + sw, cy)
  })
  ctx.restore()
}

export function toCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d')!.putImageData(img, 0, 0)
  return c
}

export interface ComposeOptions {
  wl: WindowLevel
  scale: number
  overlay: boolean
  legend: boolean
}

/** Final image for one slice at output resolution. */
export function compose(series: Series, slice: number, structures: Structure[], o: ComposeOptions): HTMLCanvasElement {
  const { rows, cols } = series
  const out = document.createElement('canvas')
  out.width = Math.round(cols * o.scale)
  out.height = Math.round(rows * o.scale)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(toCanvas(grayImage(series, slice, o.wl)), 0, 0, out.width, out.height)
  if (o.overlay) {
    const ov = overlayImage(structures, slice, cols, rows)
    if (ov) ctx.drawImage(toCanvas(ov), 0, 0, out.width, out.height)
    if (o.legend) drawLegend(ctx, structures, out.width, out.height)
  }
  return out
}
