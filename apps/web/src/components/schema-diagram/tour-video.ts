import { between, easeInOut, type Rect } from './camera.ts'
import { TONE_STROKE, TONES, type Tone } from './overlay.ts'
import { readMs } from './tour.ts'
import { CAMERA_MS, COLOUR, enterDelay, FIGURE_STYLE, type FigureScene, RING, type TourFigure } from './tour-figure.ts'

/** The size the video is laid out at, and how much finer it is recorded (1920 × 1080). */
const WIDTH = 1280
const HEIGHT = 720
const SCALE = 1.5
const FPS = 30
/** The last scene stays a moment before the video ends. */
const END_MS = 1500
/** As on the page: a scene fades what it does not light, boxes and lines come in, a flow runs five times. */
const FADE_MS = 300
const ENTER_MS = 500
const FLOW_MS = 900
const FLOWS = 5
const PULSE_MS = 1200
const PULSES = 2
const FAINT = 0.3

/** Where things go on the video: the diagram on the left, the words on the right, as on a wide screen. */
const FIGURE = { x: 24, y: 48, width: 800, height: 612 }
const WORDS = { x: 856, y: 48, width: 400, height: 612 }
const FONT = 'system-ui, sans-serif'
const INK = '#1a1c1f'
const SUB = '#5b616b'
const LINE = '#e3e5e8'

/** The words of the video that are not a scene's: its title, the headings of the lists, and what each colour means. */
export interface VideoWords {
  title: string
  notes: string
  hints: string
  tones: Partial<Record<Tone, string>>
}

/** When each scene starts, and how long the whole video lasts. */
export function timeline(scenes: readonly FigureScene[]): { starts: number[]; total: number } {
  const starts: number[] = []
  let at = 0
  for (const s of scenes) {
    starts.push(at)
    at += readMs(s)
  }
  return { starts, total: at + END_MS }
}

/** The scene at `t` ms into the video, how far into it, and where the camera looks (moving from the last scene's). */
export function frameAt(
  scenes: readonly FigureScene[],
  starts: readonly number[],
  t: number
): { index: number; u: number; view: Rect } {
  let index = 0
  while (index + 1 < starts.length && (starts[index + 1] ?? 0) <= t) index++
  const u = t - (starts[index] ?? 0)
  const rect = (v: readonly number[] | undefined): Rect => ({
    x: v?.[0] ?? 0,
    y: v?.[1] ?? 0,
    width: v?.[2] ?? 1,
    height: v?.[3] ?? 1,
  })
  const to = rect(scenes[index]?.view)
  const from = index > 0 ? rect(scenes[index - 1]?.view) : to
  return { index, u, view: between(from, to, easeInOut(Math.min(1, u / CAMERA_MS))) }
}

const clamp01 = (k: number) => Math.max(0, Math.min(1, k))
const faintness = (s: FigureScene | undefined, lit: (s: FigureScene) => boolean) => (s && s.fade && !lit(s) ? FAINT : 1)

/**
 * Lays scene `index` over the figure as it stands `u` ms into the scene: what the page does with classes and CSS
 * animations, done here by hand for one still frame (an image of an SVG does not run them).
 */
export function paint(root: Element, figure: TourFigure, index: number, u: number): void {
  const s = figure.scenes[index]
  if (!s) return
  const before = figure.scenes[index - 1]
  const fade = clamp01(u / FADE_MS)
  const opacity = (lit: (x: FigureScene) => boolean) => {
    const to = faintness(s, lit)
    const from = before ? faintness(before, lit) : to
    return String(Math.round((from + (to - from) * fade) * 1000) / 1000)
  }
  const tableLit = (t: number) => (x: FigureScene) => x.tables.some((l) => l[0] === t)
  const keyLit = (k: number) => (x: FigureScene) => x.keys.some((l) => l[0] === k)
  const marked = new Set(s.cols.map(([t, j]) => `${t}.${j}`))

  root.querySelectorAll('g.t').forEach((g, t) => {
    const l = s.tables.find((x) => x[0] === t)
    g.setAttribute('class', `t${l ? ` tone-${l[1]}` : ''}`)
    g.setAttribute('opacity', opacity(tableLit(t)))
    const x = figure.boxes[t]?.[0] ?? 0
    g.querySelector('.in')?.setAttribute('opacity', String(s.enter ? clamp01((u - enterDelay(x)) / ENTER_MS) : 1))
    g.querySelectorAll('.c').forEach((c, j) => c.setAttribute('class', marked.has(`${t}.${j}`) ? 'c on' : 'c'))
    const badge = g.querySelector('.badge')
    if (!badge) return
    if (l && l.length === 4) {
      const [, , text, width] = l
      badge.removeAttribute('display')
      badge.setAttribute('transform', `translate(${(figure.boxes[t]?.[2] ?? 0) - width} -10)`)
      badge.firstElementChild?.setAttribute('width', String(width))
      badge.lastElementChild?.setAttribute('x', String(width / 2))
      if (badge.lastElementChild) badge.lastElementChild.textContent = text
    } else badge.setAttribute('display', 'none')
  })

  const flowing = clamp01(u / (FLOW_MS * FLOWS)) * FLOWS * 32
  root.querySelectorAll('g.k').forEach((g, k) => {
    const tone = s.keys.find((x) => x[0] === k)?.[1]
    const way = s.flow.find((x) => x[0] === k)?.[1]
    g.setAttribute('class', `k${tone ? ` tone-${tone}` : ''}${way ? ' flow' : ''}`)
    g.setAttribute('opacity', opacity(keyLit(k)))
    g.querySelector('.base')?.setAttribute('opacity', String(s.enter ? clamp01((u - figure.linesDelay) / ENTER_MS) : 1))
    g.querySelector('.fl')?.setAttribute('stroke-dashoffset', String(way === 'back' ? flowing : -flowing))
  })

  // A ring grows and fades around where to look first, twice.
  const rings = root.querySelector('#rings')
  if (!rings) return
  rings.textContent = ''
  if (u >= PULSE_MS * PULSES) return
  const k = (u % PULSE_MS) / PULSE_MS
  const grow = 1 - (1 - k) ** 2
  for (const t of s.pulse) {
    const [x, y, w, h] = figure.boxes[t] ?? [0, 0, 0, 0]
    const scale = 1 + 0.18 * grow
    const rw = (w + 2 * RING) * scale
    const rh = (h + 2 * RING) * scale
    const r = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect')
    r.setAttribute('x', String(x + w / 2 - rw / 2))
    r.setAttribute('y', String(y + h / 2 - rh / 2))
    r.setAttribute('width', String(rw))
    r.setAttribute('height', String(rh))
    r.setAttribute('rx', '10')
    r.setAttribute('fill', 'none')
    r.setAttribute('stroke', COLOUR.focus)
    r.setAttribute('stroke-width', '4')
    r.setAttribute('opacity', String(0.9 * (1 - grow)))
    rings.appendChild(r)
  }
}

/** The figure as an SVG document the video draws from: no animation runs in it, each frame is laid by `paint`. */
export function figureDocument(figure: TourFigure): Document {
  const style = `${FIGURE_STYLE}\n*{animation:none!important;transition:none!important}\nsvg{font-family:${FONT}}`
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${FIGURE.width * SCALE}" height="${FIGURE.height * SCALE}" preserveAspectRatio="xMidYMid meet"><style>${style}</style>${figure.markup}</svg>`
  return new DOMParser().parseFromString(markup, 'image/svg+xml')
}

/** The figure as it stands, as an image to draw (decoded before it is drawn). */
async function snapshot(doc: Document, view: Rect): Promise<HTMLImageElement> {
  doc.documentElement.setAttribute('viewBox', [view.x, view.y, view.width, view.height].join(' '))
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(doc))}`
  await img.decode()
  return img
}

type Pen = Pick<CanvasRenderingContext2D, 'measureText'>

/** `text` on one line no wider than `width`: cut, with "…" at its end, where it is wider. */
export function fitLine(pen: Pen, text: string, width: number): string {
  if (pen.measureText(text).width <= width) return text
  const chars = [...text.replace(/…$/, '')]
  while (chars.length > 0 && pen.measureText(`${chars.join('')}…`).width > width) chars.pop()
  return `${chars.join('')}…`
}

/** What does not end a line: the brackets that open a phrase. */
const OPENING = /[（「『([]$/
/** What does not start a line: the punctuation that closes a phrase. */
const CLOSING = /^[、。，．！？」』）)\],.!?:;]/

/**
 * `text` in lines no wider than `width`: a word of Latin letters and digits (a table name) is kept whole, and moved
 * to the next line rather than cut; elsewhere (as in Japanese) a line breaks between any two characters, but never
 * before the punctuation that closes a phrase. A word wider than a line is cut where it must be.
 */
export function wrap(pen: Pen, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  const fits = (s: string) => pen.measureText(s).width <= width
  const add = (unit: string) => {
    if (/^\s+$/.test(unit)) {
      if (line !== '' && fits(line + unit)) line += unit
      else if (line !== '') {
        lines.push(line)
        line = ''
      }
      return
    }
    if (line === '' || fits(line + unit) || CLOSING.test(unit)) {
      line += unit
      return
    }
    // An opening bracket goes down with what it opens.
    const open = OPENING.exec(line)?.[0] ?? ''
    lines.push(line.slice(0, line.length - open.length).trimEnd())
    line = open + unit
  }
  for (const unit of text.match(/[\x21-\x7e]+|\s+|./gsu) ?? []) {
    if (unit.length > 1 && !/^\s+$/.test(unit) && !fits(unit)) for (const ch of unit) add(ch)
    else add(unit)
  }
  if (line.trim() !== '') lines.push(line.trimEnd())
  return lines
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  'measureText' | 'fillText' | 'fillRect' | 'font' | 'fillStyle' | 'save' | 'restore' | 'beginPath' | 'rect' | 'clip'
>

/**
 * The words of a scene, on the right: which scene, its title, its words, and what it says of the design and where it
 * may cost time. A scene that says more than fits is set smaller; past the smallest, what does not fit is cut.
 */
export function drawWords(ctx: Ctx, s: FigureScene, w: VideoWords): void {
  type Block = { text: string; size: number; colour: string; bold?: boolean; gap: number; bullet?: boolean }
  const blocks: Block[] = [
    { text: s.n, size: 15, colour: SUB, gap: 0 },
    { text: s.title, size: 28, colour: INK, bold: true, gap: 8 },
    { text: s.text, size: 20, colour: INK, gap: 12 },
    ...(s.notes.length > 0 ? [{ text: w.notes, size: 15, colour: COLOUR.focus, bold: true, gap: 20 }] : []),
    ...s.notes.map((text) => ({ text, size: 17, colour: INK, gap: 6, bullet: true })),
    ...(s.hints.length > 0 ? [{ text: w.hints, size: 15, colour: COLOUR.delete, bold: true, gap: 20 }] : []),
    ...s.hints.map((text) => ({ text, size: 17, colour: INK, gap: 6, bullet: true })),
  ].filter((b) => b.text !== '')
  const BULLET = 18
  const lay = (k: number) =>
    blocks.map((b) => {
      ctx.font = `${b.bold ? '600 ' : ''}${b.size * k}px ${FONT}`
      return wrap(ctx, b.text, WORDS.width - (b.bullet ? BULLET : 0))
    })
  const height = (k: number, laid: string[][]) =>
    blocks.reduce((sum, b, i) => sum + b.gap * k + (laid[i]?.length ?? 0) * b.size * k * 1.45, 0)
  let k = 1
  let laid = lay(k)
  while (k > 0.6 && height(k, laid) > WORDS.height) {
    k -= 0.05
    laid = lay(k)
  }
  // Every line, with how far below the one before it falls; past the smallest size, the lines that do not fit are
  // left out, and the last one shown ends with "…".
  const rows = blocks.flatMap((b, i) =>
    (laid[i] ?? []).map((text, j) => ({
      text,
      step: (j === 0 ? b.gap * k : 0) + b.size * k * 1.45,
      size: b.size * k,
      font: `${b.bold ? '600 ' : ''}${b.size * k}px ${FONT}`,
      colour: b.colour,
      indent: b.bullet ? BULLET : 0,
      bullet: b.bullet === true && j === 0,
    }))
  )
  ctx.save()
  ctx.beginPath()
  ctx.rect(WORDS.x, WORDS.y, WORDS.width, WORDS.height)
  ctx.clip()
  let y = WORDS.y
  for (const [i, row] of rows.entries()) {
    y += row.step
    const next = rows[i + 1]
    const more = next !== undefined && y + next.step > WORDS.y + WORDS.height
    ctx.font = row.font
    ctx.fillStyle = row.colour
    const base = y - row.size * 0.35
    if (row.bullet) ctx.fillText('•', WORDS.x + 4, base)
    ctx.fillText(more ? fitLine(ctx, `${row.text}…`, WORDS.width - row.indent) : row.text, WORDS.x + row.indent, base)
    if (more) break
  }
  ctx.restore()
}

/** One frame: the diagram under the camera, what its colours mean, the words of the scene, and how far along it is. */
async function drawFrame(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  figure: TourFigure,
  w: VideoWords,
  at: { index: number; u: number; view: Rect }
): Promise<void> {
  paint(doc.documentElement, figure, at.index, at.u)
  const img = await snapshot(doc, at.view)
  const s = figure.scenes[at.index]
  if (!s) return
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
  ctx.fillStyle = '#f4f5f7'
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  ctx.font = `600 15px ${FONT}`
  ctx.fillStyle = SUB
  ctx.fillText(fitLine(ctx, w.title, WIDTH - 2 * FIGURE.x), FIGURE.x, 30)
  ctx.fillStyle = '#f7f8f9'
  ctx.strokeStyle = LINE
  ctx.lineWidth = 1
  ctx.fillRect(FIGURE.x, FIGURE.y, FIGURE.width, FIGURE.height)
  ctx.strokeRect(FIGURE.x, FIGURE.y, FIGURE.width, FIGURE.height)
  ctx.drawImage(img, FIGURE.x, FIGURE.y, FIGURE.width, FIGURE.height)
  // Only the colours this scene draws, as on the page.
  let x = FIGURE.x
  ctx.font = `13px ${FONT}`
  for (const tone of TONES.filter((tone) => s.legend.includes(tone) && w.tones[tone])) {
    const label = w.tones[tone] ?? ''
    // Past the figure's width, the rest of the colours are left out rather than drawn off its edge.
    if (x + 30 + ctx.measureText(label).width > FIGURE.x + FIGURE.width) break
    const stroke = TONE_STROKE[tone]
    ctx.strokeStyle = COLOUR[tone]
    ctx.lineWidth = stroke.width
    ctx.setLineDash(stroke.dash ? stroke.dash.split(' ').map(Number) : [])
    ctx.beginPath()
    ctx.moveTo(x, 680)
    ctx.lineTo(x + 24, 680)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = SUB
    ctx.fillText(label, x + 30, 685)
    x += 30 + ctx.measureText(label).width + 20
  }
  drawWords(ctx, s, w)
  // A bar for each scene, filled as far as the video has come.
  const count = figure.scenes.length
  const gap = 4
  const bar = (WIDTH - 48 - gap * (count - 1)) / count
  figure.scenes.forEach((_, i) => {
    const bx = 24 + i * (bar + gap)
    ctx.fillStyle = LINE
    ctx.fillRect(bx, 702, bar, 6)
    const done = i < at.index ? 1 : i === at.index ? clamp01(at.u / readMs(s)) : 0
    ctx.fillStyle = COLOUR.focus
    ctx.fillRect(bx, 702, bar * done, 6)
  })
}

/** The kind of file this browser records: MP4 where it can (it opens everywhere), WebM otherwise. */
export function videoType(supported: (type: string) => boolean): { mime: string; ext: string } | undefined {
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(supported)
  return mime ? { mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' } : undefined
}

/** How time passes while recording: the real clock, or a test's. */
export interface Clock {
  now: () => number
  wait: (ms: number) => Promise<void>
}
const realClock: Clock = {
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * The tour as a video with its words on it: drawn frame by frame on a canvas the browser records as it goes, so it
 * takes as long as the video lasts. `onScene` hears each scene as it is reached; `signal` stops it, and then nothing
 * is made. The voice reading aloud is not in it: the browser does not hand its sound to a page.
 */
export async function recordTour(
  figure: TourFigure,
  w: VideoWords,
  { signal, onScene, clock = realClock }: { signal: AbortSignal; onScene: (index: number) => void; clock?: Clock }
): Promise<{ blob: Blob; ext: string }> {
  const type = videoType((t) => MediaRecorder.isTypeSupported(t))
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH * SCALE
  canvas.height = HEIGHT * SCALE
  const ctx = canvas.getContext('2d')
  if (!type || !ctx) throw new Error('This browser cannot record a video.')
  signal.throwIfAborted()
  const doc = figureDocument(figure)
  const { starts, total } = timeline(figure.scenes)
  await drawFrame(ctx, doc, figure, w, frameAt(figure.scenes, starts, 0))
  const stream = canvas.captureStream(FPS)
  const chunks: Blob[] = []
  // What stopped the recorder before the end (the encoder failing): the recording ends there, and says so.
  let failed: unknown
  let recorder: MediaRecorder | undefined
  try {
    recorder = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: 6_000_000 })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onerror = (e) => {
      failed = (e as Event & { error?: unknown }).error ?? new Error('The recorder failed.')
    }
    recorder.start(1000)
    const t0 = clock.now()
    let told = -1
    for (;;) {
      const t = Math.min(clock.now() - t0, total)
      const at = frameAt(figure.scenes, starts, t)
      if (at.index !== told) {
        told = at.index
        onScene(told)
      }
      await drawFrame(ctx, doc, figure, w, at)
      if (t >= total || signal.aborted || failed !== undefined || recorder.state === 'inactive') break
      await clock.wait(Math.max(0, 1000 / FPS - (clock.now() - t0 - t)))
    }
    // The recorder stopped by itself before the end, saying nothing of why: what it made is not the whole.
    if (failed === undefined && !signal.aborted && recorder.state === 'inactive')
      failed = new Error('The recorder stopped early.')
  } finally {
    try {
      // The recorder first, so that it takes in the last frames before the canvas is let go.
      if (recorder && recorder.state !== 'inactive') {
        const stopped = new Promise<void>((resolve) => {
          if (recorder) recorder.onstop = () => resolve()
        })
        recorder.stop()
        await stopped
      }
    } finally {
      for (const track of stream.getTracks()) track.stop()
    }
  }
  if (failed !== undefined) throw failed
  if (signal.aborted) throw new DOMException('The recording was stopped.', 'AbortError')
  if (chunks.length === 0) throw new Error('The recorder made nothing.')
  return { blob: new Blob(chunks, { type: type.mime.replace(/;.*/, '') }), ext: type.ext }
}
