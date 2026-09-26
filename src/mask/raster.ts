/** Drawing primitives on binary masks (1 byte per pixel, row-major). */

export type Pt = [number, number]

/** Paints (value 1) or erases (value 0) a round brush along the segment a→b. */
export function stroke(mask: Uint8Array, w: number, h: number, a: Pt, b: Pt, radius: number, value: 0 | 1): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const steps = Math.max(1, Math.ceil(len / Math.max(0.5, radius / 3)))
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    disc(mask, w, h, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, radius, value)
  }
}

function disc(mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, value: 0 | 1): void {
  // Pixel (x, y) covers [x, x+1); its centre is at x + 0.5.
  const r2 = r * r
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(h - 1, Math.ceil(cy + r))
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(w - 1, Math.ceil(cx + r))
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = value
    }
  }
  // A brush smaller than a pixel still marks the pixel under it.
  if (r < 0.71) {
    const x = Math.floor(cx)
    const y = Math.floor(cy)
    if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = value
  }
}

/** Sets every pixel whose centre lies inside the polygon (even-odd rule). */
export function fillPolygon(mask: Uint8Array, w: number, h: number, pts: Pt[], value: 0 | 1): void {
  if (pts.length < 3) return
  const xs: number[] = []
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5
    xs.length = 0
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[(i + 1) % pts.length]
      if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) {
        xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1))
      }
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5))
      const to = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5))
      for (let x = from; x <= to; x++) mask[y * w + x] = value
    }
  }
}

export function isEmpty(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i]) return false
  return true
}

/** Run lengths, alternating 0-runs and 1-runs, starting with a 0-run. */
export function encodeRle(mask: Uint8Array): number[] {
  const runs: number[] = []
  let cur = 0
  let n = 0
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 1 : 0
    if (v === cur) n++
    else {
      runs.push(n)
      cur = v
      n = 1
    }
  }
  runs.push(n)
  return runs
}

export function decodeRle(runs: number[], length: number): Uint8Array {
  const mask = new Uint8Array(length)
  let o = 0
  runs.forEach((n, i) => {
    if (i % 2) mask.fill(1, o, Math.min(length, o + n))
    o += n
  })
  return mask
}
