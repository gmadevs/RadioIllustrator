/**
 * Shape interpolation between key slices through signed distance fields.
 *
 * Each key mask becomes a field that is negative inside and positive outside,
 * measured in pixels from the boundary. Blending two fields linearly and
 * keeping the negative part morphs one outline into the other, whatever the
 * masks were drawn with.
 *
 * Plain blending only works where the two shapes overlap: two discs side by
 * side blend into nothing halfway. So position and shape are interpolated
 * separately: both fields are moved onto the centroid the in-between slice
 * should have, and only then blended. An empty key marks where a structure
 * ends: towards it the shape of the other key shrinks evenly to nothing.
 */

const INF = 1e20

/** Squared 1D distance transform (Felzenszwalb & Huttenlocher), in place over f. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/** Euclidean distance from every pixel to the nearest pixel where seed is true. */
function distanceTo(w: number, h: number, seed: (i: number) => boolean): Float32Array {
  const grid = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) grid[i] = seed(i) ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    edt1d(f, h, d, v, z)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    edt1d(f, w, d, v, z)
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x]
  }
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(grid[i])
  return out
}

export interface KeyField {
  sdf: Float32Array
  /** Centroid in pixels; NaN for an empty mask. */
  cx: number
  cy: number
  /** Distance from the boundary to the deepest inside pixel. */
  depth: number
}

export function keyField(mask: Uint8Array, w: number, h: number): KeyField {
  let sx = 0
  let sy = 0
  let n = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    sx += i % w
    sy += (i / w) | 0
    n++
  }
  if (!n) return { sdf: new Float32Array(0), cx: NaN, cy: NaN, depth: 0 }
  const toInside = distanceTo(w, h, (i) => mask[i] !== 0)
  const toOutside = distanceTo(w, h, (i) => mask[i] === 0)
  const sdf = new Float32Array(w * h)
  let depth = 0
  for (let i = 0; i < w * h; i++) {
    sdf[i] = mask[i] ? 0.5 - toOutside[i] : toInside[i] - 0.5
    if (-sdf[i] > depth) depth = -sdf[i]
  }
  return { sdf, cx: sx / n, cy: sy / n, depth }
}

/** The mask a fraction t of the way from key a to key b. */
export function blend(a: KeyField, b: KeyField, t: number, w: number, h: number): Uint8Array {
  const aEmpty = !Number.isFinite(a.cx)
  const bEmpty = !Number.isFinite(b.cx)
  if (aEmpty && bEmpty) return new Uint8Array(w * h)
  if (aEmpty || bEmpty) {
    // Erode the remaining shape: fully there at its own key, gone at the empty one.
    const k = aEmpty ? b : a
    const erosion = (aEmpty ? 1 - t : t) * (k.depth + 0.5)
    const out = new Uint8Array(w * h)
    for (let i = 0; i < out.length; i++) if (k.sdf[i] + erosion < 0) out[i] = 1
    return out
  }
  const tx = a.cx + (b.cx - a.cx) * t
  const ty = a.cy + (b.cy - a.cy) * t
  const ax = Math.round(tx - a.cx)
  const ay = Math.round(ty - a.cy)
  const bx = Math.round(tx - b.cx)
  const by = Math.round(ty - b.cy)
  const far = w + h
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const ya = y - ay
    const yb = y - by
    for (let x = 0; x < w; x++) {
      const xa = x - ax
      const xb = x - bx
      const fa = xa >= 0 && ya >= 0 && xa < w && ya < h ? a.sdf[ya * w + xa] : far
      const fb = xb >= 0 && yb >= 0 && xb < w && yb < h ? b.sdf[yb * w + xb] : far
      if ((1 - t) * fa + t * fb < 0) out[y * w + x] = 1
    }
  }
  return out
}
