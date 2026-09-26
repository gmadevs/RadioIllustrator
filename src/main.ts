import { marked } from 'marked'
import readme from '../README.md?raw'
import { autoWindow, loadFiles, type Series } from './dicom/load'
import { buildExport, download, saveToDirectory, zip, type ExportedFile } from './export'
import { fillPolygon, isEmpty, stroke, type Pt } from './mask/raster'
import {
  PALETTE,
  paletteColor,
  History,
  createStructure,
  fromProjectFile,
  maskAt,
  reinterpolate,
  setKey,
  toProjectFile,
  type ProjectFile,
  type Structure,
} from './model'
import { annotated, drawLegend, grayImage, overlayImage, toCanvas, type WindowLevel } from './render'

type Tool = 'brush' | 'eraser' | 'polygon' | 'pan'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const view = $<HTMLCanvasElement>('view')
const ctx = view.getContext('2d')!
const stage = $<HTMLElement>('stage')
const dropzone = $<HTMLElement>('dropzone')
const hud = $<HTMLElement>('hud')
const slider = $<HTMLInputElement>('slice-slider')
const keystrip = $<HTMLCanvasElement>('keystrip')
const list = $<HTMLUListElement>('structure-list')

// ---------------------------------------------------------------- state

let allSeries: Series[] = []
let series: Series | null = null
let slice = 0
let wl: WindowLevel = { center: 0, width: 1 }
let structures: Structure[] = []
let active: Structure | null = null
let tool: Tool = 'brush'
let brushRadius = 4
let overlayOn = true
let legendPreview = false
const history = new History()

/** Image → screen: screen = offset + image * scale (CSS pixels). */
const cam = { scale: 1, ox: 0, oy: 0 }

let polygon: Pt[] = []
let pointer: { x: number; y: number } | null = null
let spaceDown = false

// ---------------------------------------------------------------- loading

async function openFiles(files: File[]): Promise<void> {
  if (!files.length) return
  toast(`Reading ${files.length} files…`)
  const res = await loadFiles(files)
  if (!res.series.length) {
    toast(['No readable DICOM images.', ...res.errors.slice(0, 5)].join('\n'), true)
    return
  }
  allSeries = res.series
  const select = $<HTMLSelectElement>('series-select')
  select.innerHTML = ''
  allSeries.forEach((s, i) => {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = `${s.modality} · ${s.description} · ${s.slices.length} img`
    select.append(o)
  })
  select.hidden = allSeries.length < 2
  selectSeries(0)
  if (res.errors.length) {
    const more = res.errors.length > 4 ? `\n… and ${res.errors.length - 4} more` : ''
    toast([`${res.errors.length} files skipped:`, ...res.errors.slice(0, 4)].join('\n') + more, true)
  }
}

function selectSeries(i: number): void {
  series = allSeries[i]
  slice = Math.floor(series.slices.length / 2)
  wl = { ...series.window }
  structures = []
  active = null
  polygon = []
  history.clear()
  dropzone.classList.add('hidden')
  slider.max = String(series.slices.length - 1)
  slider.value = String(slice)
  for (const id of ['save-project', 'load-project', 'export']) $<HTMLButtonElement>(id).disabled = false
  buildWlPresets()
  if (!restoreAutosave()) addStructure('Spinal canal')
  fit()
  refresh()
}

async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((it) => it.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) return [...dt.files]
  const out: File[] = []
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)))
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader()
      // readEntries returns batches; an empty batch means the directory is done.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const c of batch) await walk(c)
      }
    }
  }
  for (const e of entries) await walk(e)
  return out
}

// ---------------------------------------------------------------- window presets

function buildWlPresets(): void {
  if (!series) return
  const sel = $<HTMLSelectElement>('wl-preset')
  const presets: [string, WindowLevel][] = [['From DICOM', { ...series.window }]]
  presets.push(['Automatic', autoWindow(series.slices[slice].pixels)])
  if (series.modality === 'CT') {
    presets.push(['Soft tissue (40/400)', { center: 40, width: 400 }])
    presets.push(['Bone (400/1800)', { center: 400, width: 1800 }])
    presets.push(['Canal / cord (40/250)', { center: 40, width: 250 }])
  }
  sel.innerHTML = ''
  presets.forEach(([name, w], i) => {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = name
    o.dataset.c = String(w.center)
    o.dataset.w = String(w.width)
    sel.append(o)
  })
}

// ---------------------------------------------------------------- structures

function addStructure(name?: string): Structure {
  const s = createStructure(name ?? `Structure ${structures.length + 1}`, paletteColor(structures.length))
  structures.push(s)
  active = s
  renderList()
  return s
}

function renderList(): void {
  list.innerHTML = ''
  if (!structures.length) {
    list.innerHTML = '<li class="empty">No structures. Click “+ New”.</li>'
  }
  for (const s of structures) {
    const li = document.createElement('li')
    li.classList.toggle('active', s === active)
    li.innerHTML = `
      <div class="top">
        <input type="color" value="${s.color}" title="Color" />
        <input type="text" list="structure-names" value="${escapeHtml(s.name)}" title="Name" />
        <button class="icon vis" title="Show/hide">${s.visible ? '●' : '○'}</button>
        <button class="icon del" title="Delete structure">✕</button>
      </div>
      <div class="swatches">${PALETTE.map(
        (c) =>
          `<button class="swatch${c.hex === s.color ? ' on' : ''}" data-color="${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`,
      ).join('')}</div>
      <label class="row">
        <span class="meta">Opacity</span>
        <input type="range" class="opacity" min="0" max="1" step="0.05" value="${s.opacity}" />
      </label>
      <div class="opts">
        <label class="check"><input type="checkbox" class="outline" ${s.outline ? 'checked' : ''} /> outline</label>
        <label class="check"><input type="checkbox" class="interp" ${s.interpolate ? 'checked' : ''} /> interpolate</label>
      </div>
      <div class="meta stats">${structureStats(s)}</div>`
    li.addEventListener('pointerdown', () => {
      if (active !== s) {
        active = s
        for (const other of list.children) other.classList.remove('active')
        li.classList.add('active')
        refresh(false)
      }
    })
    const q = <T extends HTMLElement>(sel: string) => li.querySelector(sel) as T
    const colorInput = q<HTMLInputElement>('input[type=color]')
    const swatches = [...li.querySelectorAll<HTMLButtonElement>('.swatch')]
    // Set through the CSSOM: the Content Security Policy blocks inline style attributes.
    swatches.forEach((b) => b.style.setProperty('--c', b.dataset.color!))
    const setColor = (hex: string) => {
      s.color = hex
      colorInput.value = hex
      swatches.forEach((b) => b.classList.toggle('on', b.dataset.color === hex))
      changed(false)
    }
    swatches.forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color!)))
    // Updating in place keeps the system color picker open while you drag in it.
    colorInput.addEventListener('input', () => setColor(colorInput.value))
    q<HTMLInputElement>('input[type=text]').addEventListener('input', (e) => {
      s.name = (e.target as HTMLInputElement).value
      changed(false)
    })
    q<HTMLButtonElement>('.vis').addEventListener('click', () => {
      s.visible = !s.visible
      changed()
    })
    q<HTMLButtonElement>('.del').addEventListener('click', () => {
      const has = s.keys.size > 0
      if (has && !confirm(`Delete “${s.name}” and its ${s.keys.size} key slices?`)) return
      structures = structures.filter((x) => x !== s)
      if (active === s) active = structures[0] ?? null
      changed()
    })
    q<HTMLInputElement>('.opacity').addEventListener('input', (e) => {
      s.opacity = Number((e.target as HTMLInputElement).value)
      changed(false)
    })
    q<HTMLInputElement>('.outline').addEventListener('change', (e) => {
      s.outline = (e.target as HTMLInputElement).checked
      changed(false)
    })
    q<HTMLInputElement>('.interp').addEventListener('change', (e) => {
      s.interpolate = (e.target as HTMLInputElement).checked
      changed()
    })
    list.append(li)
  }
}

function structureStats(s: Structure): string {
  if (!s.keys.size) return 'no slices drawn'
  const k = [...s.keys.keys()]
  const from = Math.min(...k) + 1
  const to = Math.max(...k) + 1
  const interp = s.interpolate ? `, ${s.filled.size} interpolated` : ''
  return `${s.keys.size} key${s.keys.size === 1 ? '' : 's'}${interp} · slices ${from}–${to}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** After any structure change: redraw, and optionally rebuild the list. */
function changed(rebuildList = true): void {
  if (rebuildList) renderList()
  else updateStats()
  scheduleAutosave()
  refresh(false)
}

function updateStats(): void {
  structures.forEach((s, i) => {
    const meta = list.children[i]?.querySelector('.stats')
    if (meta) meta.textContent = structureStats(s)
  })
}

function ensureActive(): Structure {
  return active ?? addStructure()
}

// ---------------------------------------------------------------- editing

let strokeState: { s: Structure; before: Uint8Array | undefined; mask: Uint8Array; last: Pt; value: 0 | 1 } | null = null

function beginEdit(s: Structure): { before: Uint8Array | undefined; mask: Uint8Array } {
  const n = series!.rows * series!.cols
  const before = s.keys.get(slice)?.slice()
  // Editing an interpolated slice starts from what is shown there.
  const start = s.keys.get(slice) ?? maskAt(s, slice)?.slice() ?? new Uint8Array(n)
  s.keys.set(slice, start)
  s.sdf.delete(slice)
  return { before, mask: start }
}

function commitEdit(s: Structure, before: Uint8Array | undefined): void {
  const after = s.keys.get(slice)
  history.push({ structure: s, slice, before, after: after?.slice() })
  s.sdf.delete(slice)
  reinterpolate(s, series!.cols, series!.rows)
  changed(false)
}

function setSliceMask(mask: Uint8Array | undefined, label: string): void {
  if (!series) return
  const s = ensureActive()
  const before = s.keys.get(slice)?.slice()
  setKey(s, slice, mask)
  commitEdit(s, before)
  toast(label)
}

function copyFrom(offset: number): void {
  if (!series || !active) return
  const src = maskAt(active, slice + offset)
  if (!src) {
    toast(`No mask on slice ${slice + offset + 1}`, true)
    return
  }
  setSliceMask(src.slice(), `Copied from slice ${slice + offset + 1}`)
}

function undo(redo = false): void {
  const e = redo ? history.redo() : history.undo()
  if (!e || !series) return
  reinterpolate(e.structure, series.cols, series.rows)
  goTo(e.slice)
  changed(!structures.includes(e.structure))
}

// ---------------------------------------------------------------- camera

function toImage(x: number, y: number): Pt {
  return [(x - cam.ox) / cam.scale, (y - cam.oy) / cam.scale]
}

function fit(): void {
  if (!series) return
  const r = stage.getBoundingClientRect()
  cam.scale = Math.min((r.width - 20) / series.cols, (r.height - 20) / series.rows)
  cam.ox = (r.width - series.cols * cam.scale) / 2
  cam.oy = (r.height - series.rows * cam.scale) / 2
  refresh(false)
}

function zoomAt(x: number, y: number, factor: number): void {
  const [ix, iy] = toImage(x, y)
  cam.scale = Math.min(40, Math.max(0.1, cam.scale * factor))
  cam.ox = x - ix * cam.scale
  cam.oy = y - iy * cam.scale
  refresh(false)
}

function goTo(i: number): void {
  if (!series) return
  const next = Math.max(0, Math.min(series.slices.length - 1, i))
  if (next === slice) return
  slice = next
  slider.value = String(slice)
  refresh(false)
}

// ---------------------------------------------------------------- drawing

let grayCache: { key: string; canvas: HTMLCanvasElement } | null = null
let frame = 0

function refresh(full = true): void {
  if (full) renderList()
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(draw)
}

function draw(): void {
  const dpr = window.devicePixelRatio || 1
  const r = stage.getBoundingClientRect()
  if (view.width !== Math.round(r.width * dpr) || view.height !== Math.round(r.height * dpr)) {
    view.width = Math.round(r.width * dpr)
    view.height = Math.round(r.height * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, r.width, r.height)
  drawKeystrip()
  if (!series) {
    hud.textContent = ''
    return
  }

  const key = `${series.uid}:${slice}:${wl.center}:${wl.width}`
  if (grayCache?.key !== key) grayCache = { key, canvas: toCanvas(grayImage(series, slice, wl)) }

  ctx.save()
  ctx.translate(cam.ox, cam.oy)
  ctx.scale(cam.scale, cam.scale)
  ctx.imageSmoothingEnabled = cam.scale < 4
  ctx.drawImage(grayCache.canvas, 0, 0)
  if (overlayOn) {
    const ov = overlayImage(structures, slice, series.cols, series.rows)
    ctx.imageSmoothingEnabled = false
    if (ov) ctx.drawImage(toCanvas(ov), 0, 0)
    if (legendPreview) drawLegend(ctx, structures, series.cols, series.rows)
  }
  ctx.restore()

  // Polygon in progress.
  if (polygon.length) {
    const color = active?.color ?? '#fff'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    polygon.forEach(([x, y], i) => {
      const sx = cam.ox + x * cam.scale
      const sy = cam.oy + y * cam.scale
      if (i) ctx.lineTo(sx, sy)
      else ctx.moveTo(sx, sy)
    })
    if (pointer) ctx.lineTo(pointer.x, pointer.y)
    ctx.stroke()
    polygon.forEach(([x, y], i) => {
      ctx.beginPath()
      ctx.arc(cam.ox + x * cam.scale, cam.oy + y * cam.scale, i === 0 ? 5 : 3, 0, Math.PI * 2)
      ctx.fill()
    })
  }

  // Brush outline.
  if (pointer && (tool === 'brush' || tool === 'eraser') && !spaceDown) {
    ctx.strokeStyle = tool === 'eraser' ? '#fff' : active?.color ?? '#fff'
    ctx.setLineDash(tool === 'eraser' ? [4, 3] : [])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(pointer.x, pointer.y, Math.max(1, brushRadius * cam.scale), 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const s = active
  const state = !s
    ? '—'
    : s.keys.has(slice)
      ? isEmpty(s.keys.get(slice)!) ? 'Empty key (structure ends here)' : 'Key slice'
      : s.interpolate && s.filled.has(slice)
        ? 'Interpolated'
        : 'No mask'
  $<HTMLElement>('slice-state').textContent = state
  $<HTMLButtonElement>('demote-key').disabled = !s?.keys.has(slice)
  $<HTMLElement>('slice-label').textContent = `${slice + 1} / ${series.slices.length}`
  hud.textContent = [
    `${series.modality} ${series.description}`,
    `Slice ${slice + 1}/${series.slices.length}   W ${Math.round(wl.width)}  C ${Math.round(wl.center)}   ${Math.round(cam.scale * 100)}%`,
    overlayOn ? '' : 'Overlay hidden (O)',
  ].join('\n')
}

function drawKeystrip(): void {
  const dpr = window.devicePixelRatio || 1
  const w = keystrip.clientWidth
  const h = keystrip.clientHeight
  keystrip.width = Math.round(w * dpr)
  keystrip.height = Math.round(h * dpr)
  const k = keystrip.getContext('2d')!
  k.setTransform(dpr, 0, 0, dpr, 0, 0)
  k.clearRect(0, 0, w, h)
  if (!series) return
  const n = series.slices.length
  // The slider thumb travels between half-thumb insets; line the ticks up with it.
  const inset = 8
  const x = (i: number) => inset + (n > 1 ? (i / (n - 1)) * (w - 2 * inset) : (w - 2 * inset) / 2)
  const cw = Math.max(2, (w - 2 * inset) / n - 1)
  k.fillStyle = '#2a2e33'
  k.fillRect(inset - cw / 2, h - 3, w - 2 * inset + cw, 3)
  if (active) {
    k.fillStyle = active.color
    if (active.interpolate) {
      k.globalAlpha = 0.45
      for (const i of active.filled.keys()) k.fillRect(x(i) - cw / 2, h - 7, cw, 7)
    }
    k.globalAlpha = 1
    for (const [i, m] of active.keys) {
      if (isEmpty(m)) {
        k.strokeStyle = active.color
        k.strokeRect(x(i) - cw / 2 + 0.5, 0.5, cw - 1, h - 1)
      } else k.fillRect(x(i) - cw / 2, 0, cw, h)
    }
  }
  k.fillStyle = '#fff'
  k.fillRect(x(slice) - 1, 0, 2, h)
}

// ---------------------------------------------------------------- pointer input

let drag: { kind: 'pan' | 'wl'; x: number; y: number; ox: number; oy: number; c: number; w: number } | null = null

view.addEventListener('contextmenu', (e) => e.preventDefault())

view.addEventListener('pointerdown', (e) => {
  if (!series) return
  view.setPointerCapture(e.pointerId)
  const { offsetX: x, offsetY: y } = e
  if (e.button === 2) {
    drag = { kind: 'wl', x, y, ox: 0, oy: 0, c: wl.center, w: wl.width }
    return
  }
  if (e.button === 1 || tool === 'pan' || spaceDown) {
    drag = { kind: 'pan', x, y, ox: cam.ox, oy: cam.oy, c: 0, w: 0 }
    return
  }
  if (e.button !== 0) return
  const p = toImage(x, y)

  if (tool === 'polygon') {
    if (polygon.length >= 3) {
      const [fx, fy] = polygon[0]
      if (Math.hypot(fx * cam.scale + cam.ox - x, fy * cam.scale + cam.oy - y) < 9) {
        closePolygon(e.altKey)
        return
      }
    }
    polygon.push(p)
    refresh(false)
    return
  }

  const s = ensureActive()
  const { before, mask } = beginEdit(s)
  const value: 0 | 1 = tool === 'eraser' || e.altKey ? 0 : 1
  stroke(mask, series.cols, series.rows, p, p, brushRadius, value)
  strokeState = { s, before, mask, last: p, value }
  refresh(false)
})

view.addEventListener('pointermove', (e) => {
  const { offsetX: x, offsetY: y } = e
  pointer = { x, y }
  if (drag?.kind === 'pan') {
    cam.ox = drag.ox + x - drag.x
    cam.oy = drag.oy + y - drag.y
  } else if (drag?.kind === 'wl') {
    // Scale the drag to the window width so it feels the same on CT and MR.
    const k = Math.max(1, drag.w) / 300
    wl = { center: drag.c - (y - drag.y) * k, width: Math.max(1, drag.w + (x - drag.x) * k) }
  } else if (strokeState && series) {
    const p = toImage(x, y)
    stroke(strokeState.mask, series.cols, series.rows, strokeState.last, p, brushRadius, strokeState.value)
    strokeState.last = p
  }
  refresh(false)
})

function endPointer(): void {
  drag = null
  if (strokeState) {
    const { s, before } = strokeState
    strokeState = null
    commitEdit(s, before)
  }
}
view.addEventListener('pointerup', endPointer)
view.addEventListener('pointercancel', endPointer)
view.addEventListener('pointerleave', () => {
  pointer = null
  refresh(false)
})

view.addEventListener('dblclick', () => {
  // The double click already added its point twice; drop the duplicate.
  if (tool === 'polygon' && polygon.length > 3) {
    polygon.pop()
    closePolygon(false)
  }
})

function closePolygon(subtract: boolean): void {
  if (!series || polygon.length < 3) {
    polygon = []
    return
  }
  const s = ensureActive()
  const { before, mask } = beginEdit(s)
  fillPolygon(mask, series.cols, series.rows, polygon, subtract ? 0 : 1)
  polygon = []
  commitEdit(s, before)
}

view.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01))
      return
    }
    // Trackpads send many small deltas; step one slice per notch-equivalent.
    wheelAcc += e.deltaY
    const steps = Math.trunc(wheelAcc / 40)
    if (steps) {
      wheelAcc -= steps * 40
      goTo(slice + Math.sign(steps) * Math.max(1, Math.abs(steps) > 3 ? 3 : Math.abs(steps)))
    }
  },
  { passive: false },
)
let wheelAcc = 0

// ---------------------------------------------------------------- keyboard

function setTool(t: Tool): void {
  tool = t
  if (t !== 'polygon') polygon = []
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t))
  view.style.cursor = t === 'pan' ? 'grab' : t === 'polygon' ? 'crosshair' : 'none'
  refresh(false)
}

function setBrush(r: number): void {
  brushRadius = Math.max(0.5, Math.min(40, r))
  $<HTMLInputElement>('brush-size').value = String(brushRadius)
  $<HTMLOutputElement>('brush-size-out').textContent = String(brushRadius)
  refresh(false)
}

window.addEventListener('keydown', (e) => {
  const target = e.target
  if (target instanceof HTMLElement && target.matches('input[type=text], input[type=number], textarea, select')) return
  if ($<HTMLDialogElement>('export-dialog').open || $<HTMLDialogElement>('help-dialog').open) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    undo(e.shiftKey)
    return
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    undo(true)
    return
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    saveProject()
    return
  }
  if (mod) return
  switch (e.key) {
    case 'b': case 'B': setTool('brush'); break
    case 'e': case 'E': setTool('eraser'); break
    case 'p': case 'P': setTool('polygon'); break
    case 'h': case 'H': setTool('pan'); break
    case 'f': case 'F': fit(); break
    case 'o': case 'O': overlayOn = !overlayOn; refresh(false); break
    case 'c': copyFrom(-1); break
    case 'C': copyFrom(1); break
    case '[': setBrush(brushRadius - (brushRadius > 4 ? 1 : 0.5)); break
    case ']': setBrush(brushRadius + (brushRadius >= 4 ? 1 : 0.5)); break
    case 'ArrowUp': case 'ArrowLeft': case 'PageUp': goTo(slice - 1); break
    case 'ArrowDown': case 'ArrowRight': case 'PageDown': goTo(slice + 1); break
    case 'Home': goTo(0); break
    case 'End': goTo(Infinity); break
    case 'Enter': if (polygon.length) closePolygon(e.altKey); break
    case 'Escape': polygon = []; refresh(false); break
    case 'Backspace': if (polygon.length) { polygon.pop(); refresh(false) } break
    case ' ':
      spaceDown = true
      view.style.cursor = 'grab'
      break
    default: return
  }
  e.preventDefault()
})

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false
    setTool(tool)
  }
})

// ---------------------------------------------------------------- project files & autosave

function currentProject(): ProjectFile | null {
  if (!series) return null
  return toProjectFile(series.uid, series.rows, series.cols, series.slices.length, structures)
}

function saveProject(): void {
  const p = currentProject()
  if (!p) return
  const name = (structures[0]?.name || 'annotations').replace(/[^\w\- ]+/g, '').trim() || 'annotations'
  download(new Blob([JSON.stringify(p)], { type: 'application/json' }), `${name}.radioillustrator.json`)
}

async function loadProject(file: File): Promise<void> {
  if (!series) return
  let p: ProjectFile
  try {
    p = JSON.parse(await file.text())
    if (p.app !== 'RadioIllustrator') throw new Error()
  } catch {
    toast('This is not a RadioIllustrator annotation file.', true)
    return
  }
  if (p.rows !== series.rows || p.cols !== series.cols || p.slices !== series.slices.length) {
    toast(`The annotations are for a ${p.cols}×${p.rows}×${p.slices} series; this one is ${series.cols}×${series.rows}×${series.slices.length}.`, true)
    return
  }
  if (p.seriesUid !== series.uid && !confirm('The annotations were made on another series with the same dimensions. Load them anyway?')) return
  structures = fromProjectFile(p)
  active = structures[0] ?? null
  history.clear()
  changed()
  toast(`Loaded ${structures.length} structures`)
}

let autosaveTimer = 0
const storageKey = () => `radioillustrator:${series?.uid}`

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    const p = currentProject()
    if (!p) return
    try {
      if (p.structures.some((s) => s.keys.length)) localStorage.setItem(storageKey(), JSON.stringify(p))
      else localStorage.removeItem(storageKey())
    } catch {
      // Storage full or blocked: the explicit "Save annotations" still works.
    }
  }, 800)
}

function restoreAutosave(): boolean {
  if (!series) return false
  try {
    const raw = localStorage.getItem(storageKey())
    if (!raw) return false
    const p = JSON.parse(raw) as ProjectFile
    if (p.rows !== series.rows || p.cols !== series.cols || p.slices !== series.slices.length) return false
    structures = fromProjectFile(p)
    active = structures[0] ?? null
    renderList()
    toast('Restored the autosaved annotations for this series.')
    return structures.length > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- export dialog

const dialog = $<HTMLDialogElement>('export-dialog')
const exFrom = $<HTMLInputElement>('ex-from')
const exTo = $<HTMLInputElement>('ex-to')

function annotatedRange(): [number, number] | null {
  const all = annotated(structures).flatMap((s) => [...s.keys.keys(), ...(s.interpolate ? s.filled.keys() : [])])
  return all.length ? [Math.min(...all), Math.max(...all)] : null
}

function openExport(): void {
  if (!series) return
  const n = series.slices.length
  exFrom.max = exTo.max = String(n)
  exFrom.value = '1'
  exTo.value = String(n)
  $<HTMLSelectElement>('ex-scale').value = series.cols < 400 ? '2' : '1'
  $<HTMLInputElement>('ex-legend').checked = legendPreview
  const names = annotated(structures).map((s) => s.name).join(', ')
  $<HTMLInputElement>('ex-description').value = names ? `${series.description} - ${names}` : series.description
  $<HTMLButtonElement>('ex-folder').hidden = !('showDirectoryPicker' in window)
  $<HTMLProgressElement>('ex-progress').hidden = true
  updateSummary()
  dialog.showModal()
}

function exportOptions() {
  const form = dialog.querySelector('form')!
  const image = (new FormData(form).get('image') as string) || null
  const n = series!.slices.length
  const a = Math.max(1, Math.min(n, Number(exFrom.value) || 1))
  const b = Math.max(1, Math.min(n, Number(exTo.value) || n))
  return {
    image: image as 'png' | 'jpeg' | null,
    dicom: $<HTMLInputElement>('ex-dicom').checked,
    plain: $<HTMLInputElement>('ex-plain').checked,
    scale: Number($<HTMLSelectElement>('ex-scale').value),
    legend: $<HTMLInputElement>('ex-legend').checked,
    from: Math.min(a, b) - 1,
    to: Math.max(a, b) - 1,
    wl: { ...wl },
    seriesDescription: $<HTMLInputElement>('ex-description').value.trim() || series!.description,
  }
}

function updateSummary(): void {
  if (!series) return
  const o = exportOptions()
  const count = (o.to - o.from + 1) * (o.plain ? 2 : 1)
  const kinds = [o.image?.toUpperCase(), o.dicom ? 'DICOM' : null].filter(Boolean).join(' + ') || 'nothing'
  $<HTMLElement>('ex-summary').textContent =
    `${count} images (${kinds}), ${series.cols * o.scale}×${series.rows * o.scale} px, window W ${Math.round(o.wl.width)} C ${Math.round(o.wl.center)} (the current one).`
  const nothing = !o.image && !o.dicom
  $<HTMLButtonElement>('ex-zip').disabled = nothing
  $<HTMLButtonElement>('ex-folder').disabled = nothing
}

async function runExport(toFolder: boolean): Promise<void> {
  if (!series) return
  const o = exportOptions()
  const progress = $<HTMLProgressElement>('ex-progress')
  progress.hidden = false
  const buttons = dialog.querySelectorAll('button')
  buttons.forEach((b) => (b.disabled = true))
  try {
    const files: ExportedFile[] = await buildExport(series, structures, {
      ...o,
      onProgress: (d, t) => {
        progress.max = t
        progress.value = d
      },
    })
    if (toFolder) {
      await saveToDirectory(files)
      toast(`Saved ${files.length} files.`)
    } else {
      const base = (o.seriesDescription.replace(/[^\w.\- ]+/g, '').trim() || 'export').replace(/\s+/g, '_')
      download(zip(files), `${base}.zip`)
    }
    dialog.close()
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast(`Export failed: ${(e as Error).message}`, true)
  } finally {
    buttons.forEach((b) => (b.disabled = false))
    updateSummary()
  }
}

dialog.addEventListener('input', updateSummary)
$('ex-all').addEventListener('click', () => {
  exFrom.value = '1'
  exTo.value = String(series?.slices.length ?? 1)
  updateSummary()
})
$('ex-annotated').addEventListener('click', () => {
  const r = annotatedRange()
  if (!r) return toast('No annotated slices.', true)
  exFrom.value = String(r[0] + 1)
  exTo.value = String(r[1] + 1)
  updateSummary()
})
$('ex-zip').addEventListener('click', () => runExport(false))
$('ex-folder').addEventListener('click', () => runExport(true))

// ---------------------------------------------------------------- toolbar wiring

let toastTimer = 0
function toast(msg: string, error = false): void {
  const t = $<HTMLElement>('toast')
  t.textContent = msg
  t.classList.toggle('error', error)
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => t.classList.remove('show'), error ? 7000 : 3000)
}

$('open-files').addEventListener('click', () => $<HTMLInputElement>('file-input').click())
$('open-dir').addEventListener('click', () => $<HTMLInputElement>('dir-input').click())
for (const id of ['file-input', 'dir-input']) {
  const input = $<HTMLInputElement>(id)
  input.addEventListener('change', () => {
    openFiles([...(input.files ?? [])])
    input.value = ''
  })
}
$<HTMLSelectElement>('series-select').addEventListener('change', (e) => selectSeries(Number((e.target as HTMLSelectElement).value)))
$('save-project').addEventListener('click', saveProject)
$('load-project').addEventListener('click', () => $<HTMLInputElement>('project-input').click())
$<HTMLInputElement>('project-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement
  if (input.files?.[0]) loadProject(input.files[0])
  input.value = ''
})
$('export').addEventListener('click', openExport)
$('help').addEventListener('click', () => {
  const content = $<HTMLElement>('help-content')
  // The README is part of this repository, so its HTML is trusted.
  if (!content.innerHTML) content.innerHTML = marked.parse(readme, { async: false })
  // GitHub-style heading ids, so links like #uploading-with-radiouploader work here too.
  content.querySelectorAll('h1, h2, h3').forEach((h) => {
    h.id = (h.textContent ?? '').trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/ /g, '-')
  })
  // The dialog is always dark: show the dark variant of a <picture>.
  content.querySelectorAll('picture').forEach((pic) => {
    const dark = pic.querySelector('source[media*="dark"]')?.getAttribute('srcset')
    const img = pic.querySelector('img')
    if (dark && img) img.setAttribute('src', dark)
    pic.querySelectorAll('source').forEach((src) => src.remove())
  })
  // The README points at public/ for GitHub; on the site those files are at the root.
  content.querySelectorAll<HTMLImageElement>('img[src^="public/"]').forEach((img) => {
    img.src = `./${img.getAttribute('src')!.slice('public/'.length)}`
  })
  content.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  })
  $<HTMLDialogElement>('help-dialog').showModal()
})
$('add-structure').addEventListener('click', () => {
  addStructure()
  refresh(false)
})
$<HTMLInputElement>('legend-preview').addEventListener('change', (e) => {
  legendPreview = (e.target as HTMLInputElement).checked
  refresh(false)
})

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)))
$<HTMLInputElement>('brush-size').addEventListener('input', (e) => setBrush(Number((e.target as HTMLInputElement).value)))
$<HTMLSelectElement>('wl-preset').addEventListener('change', (e) => {
  const o = (e.target as HTMLSelectElement).selectedOptions[0]
  wl = { center: Number(o.dataset.c), width: Number(o.dataset.w) }
  refresh(false)
})

$('copy-prev').addEventListener('click', () => copyFrom(-1))
$('copy-next').addEventListener('click', () => copyFrom(1))
$('demote-key').addEventListener('click', () => {
  if (!active?.keys.has(slice)) return
  setSliceMask(undefined, 'The slice is interpolated again')
})
$('clear-slice').addEventListener('click', () => {
  if (!series) return
  setSliceMask(new Uint8Array(series.rows * series.cols), 'Slice cleared: the structure ends here')
})

slider.addEventListener('input', () => goTo(Number(slider.value)))
keystrip.addEventListener('pointerdown', (e) => {
  if (!series) return
  const pick = (x: number) => {
    const n = series!.slices.length
    goTo(Math.round(((x - 8) / (keystrip.clientWidth - 16)) * (n - 1)))
  }
  pick(e.offsetX)
  keystrip.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => pick(ev.offsetX)
  keystrip.addEventListener('pointermove', move)
  keystrip.addEventListener('pointerup', () => keystrip.removeEventListener('pointermove', move), { once: true })
})

// Drag and drop anywhere on the page.
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropzone.classList.remove('hidden')
  dropzone.classList.add('over')
})
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return
  dropzone.classList.remove('over')
  if (series) dropzone.classList.add('hidden')
})
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dropzone.classList.remove('over')
  if (series) dropzone.classList.add('hidden')
  if (!e.dataTransfer) return
  const files = await filesFromDrop(e.dataTransfer)
  const project = files.length === 1 && files[0].name.endsWith('.json')
  if (project) loadProject(files[0])
  else openFiles(files)
})

new ResizeObserver(() => (series ? fit() : refresh(false))).observe(stage)
window.addEventListener('beforeunload', () => {
  clearTimeout(autosaveTimer)
  const p = currentProject()
  try {
    if (p && p.structures.some((s) => s.keys.length)) localStorage.setItem(storageKey(), JSON.stringify(p))
  } catch {
    // ignore
  }
})

setTool('brush')
renderList()
