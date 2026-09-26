import { zipSync } from 'fflate'
import type { Series } from './dicom/load'
import { newUid, secondaryCapture } from './dicom/write'
import type { Structure } from './model'
import { compose, type WindowLevel } from './render'

export interface ExportOptions {
  image: 'png' | 'jpeg' | null
  dicom: boolean
  /** Also write the same slices without overlay, for a before/after pair of stacks. */
  plain: boolean
  scale: number
  legend: boolean
  from: number
  to: number
  wl: WindowLevel
  seriesDescription: string
  onProgress: (done: number, total: number) => void
}

export interface ExportedFile {
  path: string
  data: Uint8Array
}

export async function buildExport(series: Series, structures: Structure[], o: ExportOptions): Promise<ExportedFile[]> {
  const files: ExportedFile[] = []
  const variants = o.plain ? [true, false] : [true]
  const total = (o.to - o.from + 1) * variants.length
  let done = 0

  for (const overlay of variants) {
    const folder = overlay ? 'annotated' : 'original'
    const seriesUid = newUid()
    // Series numbers well above the scanner's so the new series sorts after the original.
    const seriesNumber = overlay ? 9001 : 9002
    const description = overlay ? o.seriesDescription : `${o.seriesDescription} (no overlay)`
    for (let s = o.from; s <= o.to; s++) {
      const n = s - o.from + 1
      const name = String(n).padStart(3, '0')
      const canvas = compose(series, s, structures, { wl: o.wl, scale: o.scale, overlay, legend: o.legend })
      if (o.image) {
        const blob = await canvasBlob(canvas, o.image)
        files.push({ path: `${folder}/${o.image}/${name}.${o.image === 'png' ? 'png' : 'jpg'}`, data: new Uint8Array(await blob.arrayBuffer()) })
      }
      if (o.dicom) {
        const rgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
        files.push({
          path: `${folder}/dicom/IMG${name}.dcm`,
          data: secondaryCapture(series.slices[s], rgba, {
            seriesUid,
            seriesNumber,
            seriesDescription: description,
            instanceNumber: n,
            scale: o.scale,
          }),
        })
      }
      o.onProgress(++done, total)
      // Let the progress bar paint.
      if (done % 4 === 0) await new Promise((r) => setTimeout(r))
    }
  }
  return files
}

function canvasBlob(c: HTMLCanvasElement, type: 'png' | 'jpeg'): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('encoding failed'))), `image/${type}`, 0.95),
  )
}

export function zip(files: ExportedFile[]): Blob {
  const tree: Record<string, Uint8Array> = {}
  for (const f of files) tree[f.path] = f.data
  // PNG and JPEG are already compressed; DICOM RGB compresses well.
  const out = zipSync(tree, { level: 1 })
  return new Blob([out], { type: 'application/zip' })
}

/** Chromium's File System Access API: write straight into a folder the user picks. */
export async function saveToDirectory(files: ExportedFile[]): Promise<boolean> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker
  if (!picker) return false
  const root = await picker({ mode: 'readwrite' })
  for (const f of files) {
    const parts = f.path.split('/')
    let dir = root
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true })
    const w = await handle.createWritable()
    await w.write(f.data as Uint8Array<ArrayBuffer>)
    await w.close()
  }
  return true
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}
