import { blend, keyField, type KeyField } from './mask/interpolate'
import { decodeRle, encodeRle } from './mask/raster'

/**
 * A structure is one coloured overlay (spinal canal, a sulcus...). Slices the
 * user drew on are keys; the slices between two keys are filled by
 * interpolation and are overwritten whenever the keys change. Drawing on an
 * interpolated slice turns it into a key.
 */
export interface Structure {
  id: string
  name: string
  color: string
  opacity: number
  outline: boolean
  visible: boolean
  interpolate: boolean
  keys: Map<number, Uint8Array>
  filled: Map<number, Uint8Array>
  sdf: Map<number, KeyField>
}

export const PALETTE = ['#ff3b30', '#ffcc00', '#34c759', '#00c7ff', '#af52de', '#ff9500', '#ff2d92', '#5ac8fa']

let nextId = 1

export function createStructure(name: string, color: string): Structure {
  return {
    id: `s${nextId++}`,
    name,
    color,
    opacity: 0.4,
    outline: true,
    visible: true,
    interpolate: true,
    keys: new Map(),
    filled: new Map(),
    sdf: new Map(),
  }
}

/** The mask shown on a slice: the key if there is one, else the interpolated one. */
export function maskAt(s: Structure, slice: number): Uint8Array | undefined {
  return s.keys.get(slice) ?? (s.interpolate ? s.filled.get(slice) : undefined)
}

export function reinterpolate(s: Structure, w: number, h: number): void {
  s.filled.clear()
  const keys = [...s.keys.keys()].sort((a, b) => a - b)
  for (let k = 0; k + 1 < keys.length; k++) {
    const a = keys[k]
    const b = keys[k + 1]
    if (b - a < 2) continue
    const fa = sdfFor(s, a, w, h)
    const fb = sdfFor(s, b, w, h)
    for (let i = a + 1; i < b; i++) s.filled.set(i, blend(fa, fb, (i - a) / (b - a), w, h))
  }
}

function sdfFor(s: Structure, slice: number, w: number, h: number): KeyField {
  let f = s.sdf.get(slice)
  if (!f) {
    f = keyField(s.keys.get(slice)!, w, h)
    s.sdf.set(slice, f)
  }
  return f
}

/** Undo history of key edits. Interpolated slices are derived and never stored. */
export interface Edit {
  structure: Structure
  slice: number
  before: Uint8Array | undefined
  after: Uint8Array | undefined
}

export class History {
  private undoStack: Edit[] = []
  private redoStack: Edit[] = []

  push(e: Edit): void {
    this.undoStack.push(e)
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
  }

  undo(): Edit | undefined {
    const e = this.undoStack.pop()
    if (e) {
      setKey(e.structure, e.slice, e.before)
      this.redoStack.push(e)
    }
    return e
  }

  redo(): Edit | undefined {
    const e = this.redoStack.pop()
    if (e) {
      setKey(e.structure, e.slice, e.after)
      this.undoStack.push(e)
    }
    return e
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }
}

export function setKey(s: Structure, slice: number, mask: Uint8Array | undefined): void {
  if (mask) s.keys.set(slice, mask.slice())
  else s.keys.delete(slice)
  s.sdf.delete(slice)
}

/** Saved annotation file. Only keys are stored; interpolation is rebuilt on load. */
export interface ProjectFile {
  app: 'RadioIllustrator'
  version: 1
  seriesUid: string
  rows: number
  cols: number
  slices: number
  structures: {
    name: string
    color: string
    opacity: number
    outline: boolean
    visible: boolean
    interpolate: boolean
    keys: { slice: number; rle: number[] }[]
  }[]
}

export function toProjectFile(
  seriesUid: string,
  rows: number,
  cols: number,
  slices: number,
  structures: Structure[],
): ProjectFile {
  return {
    app: 'RadioIllustrator',
    version: 1,
    seriesUid,
    rows,
    cols,
    slices,
    structures: structures.map((s) => ({
      name: s.name,
      color: s.color,
      opacity: s.opacity,
      outline: s.outline,
      visible: s.visible,
      interpolate: s.interpolate,
      keys: [...s.keys].sort((a, b) => a[0] - b[0]).map(([slice, m]) => ({ slice, rle: encodeRle(m) })),
    })),
  }
}

export function fromProjectFile(p: ProjectFile): Structure[] {
  const n = p.rows * p.cols
  return p.structures.map((d) => {
    const s = createStructure(d.name, d.color)
    Object.assign(s, {
      opacity: d.opacity,
      outline: d.outline,
      visible: d.visible,
      interpolate: d.interpolate,
    })
    for (const k of d.keys) s.keys.set(k.slice, decodeRle(k.rle, n))
    reinterpolate(s, p.cols, p.rows)
    return s
  })
}
