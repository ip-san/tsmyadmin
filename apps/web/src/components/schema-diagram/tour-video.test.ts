import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relation } from '@/test/schema-fixtures.ts'
import { diagramFor } from './overlay.ts'
import { overlay, readMs, type TourScene, whole } from './tour.ts'
import { CAMERA_MS, type FigureScene, tourFigure } from './tour-figure.ts'
import {
  drawWords,
  figureDocument,
  fitLine,
  frameAt,
  paint,
  recordTour,
  span,
  timeline,
  videoType,
  wrap,
} from './tour-video.ts'

// users ← orders: the whole first, then the two lit, the key flowing back, a badge, a column marked and a ring.
const toUsers = relation('orders', ['user_id'], 'users')
// Tables enough that the whole is wider than a close look.
const others = Array.from({ length: 12 }, (_, i) => `t${i}`)
const diagram = diagramFor(['users', 'orders', 'logs', ...others], [toUsers])
const scenes: TourScene[] = [
  { title: 'shop', text: 'all of it', frame: [], overlay: whole(true), pulse: [] },
  {
    title: 'orders refer to users',
    text: 'x'.repeat(100),
    frame: ['orders', 'users'],
    overlay: overlay({
      tables: [
        ['users', 'focus', '2'],
        ['orders', 'index'],
      ],
      relations: [[toUsers, 'focus']],
      flow: [[toUsers, 'back']],
      columns: [['orders', ['user_id']]],
    }),
    pulse: ['users'],
    notes: ['why it is so'],
    hints: ['where it costs time'],
  },
]
const figure = tourFigure(diagram, scenes, { sceneOf: (n, total) => `${n} / ${total}`, stop: '. ' })
const words = { title: 'Map of shop', notes: 'Design', hints: 'Hints', tones: { focus: 'Looked at' } }

describe('timeline and frameAt', () => {
  const { starts, total } = timeline(figure.scenes)

  it('gives each scene the time to read it, and holds the last a moment', () => {
    expect(starts).toEqual([0, readMs(scenes[0] as TourScene)])
    expect(readMs(scenes[0] as TourScene)).toBe(6000)
    expect(readMs(scenes[1] as TourScene)).toBeGreaterThan(6000)
    expect(total).toBeGreaterThan((starts[1] ?? 0) + readMs(scenes[1] as TourScene))
  })

  it('moves the camera from the last scene to this one, and keeps the first still', () => {
    const [start, look] = figure.scenes.map((s) => s.view)
    const rect = (v: number[] | undefined) => ({ x: v?.[0], y: v?.[1], width: v?.[2], height: v?.[3] })
    expect(frameAt(figure.scenes, starts, 100)).toMatchObject({ index: 0, u: 100, view: rect(start) })
    const at = starts[1] ?? 0
    expect(frameAt(figure.scenes, starts, at)).toMatchObject({ index: 1, u: 0, view: rect(start) })
    expect(frameAt(figure.scenes, starts, at + CAMERA_MS).view).toEqual(rect(look))
    // Half the time, half the way (the camera eases in and out about the middle).
    const halfway = frameAt(figure.scenes, starts, at + CAMERA_MS / 2).view
    const mid = (i: number) => ((start?.[i] ?? 0) + (look?.[i] ?? 0)) / 2
    expect([halfway.x, halfway.y, halfway.width, halfway.height]).toEqual([0, 1, 2, 3].map(mid))
    expect(start).not.toEqual(look)
    expect(frameAt(figure.scenes, starts, total).index).toBe(1)
  })

  it("opens a chapter's video on its own first scene: the camera does not move in from the scene before", () => {
    const look = figure.scenes[1]?.view
    const at = starts[1] ?? 0
    expect(frameAt(figure.scenes, starts, at, 1).view).toEqual({
      x: look?.[0],
      y: look?.[1],
      width: look?.[2],
      height: look?.[3],
    })
  })

  it("times a chapter from its first scene to the next chapter's, and the last to the end of the whole", () => {
    expect(span(figure.scenes)).toMatchObject({ start: 0, end: total })
    expect(span(figure.scenes, { from: 0, to: 1 })).toMatchObject({ start: 0, end: starts[1] })
    expect(span(figure.scenes, { from: 1, to: 2 })).toMatchObject({ start: starts[1], end: total })
  })
})

describe('paint', () => {
  const fresh = () => figureDocument(figure).documentElement
  const box = (root: Element, i: number) => root.querySelectorAll('g.t')[i] as Element
  const key = (root: Element) => root.querySelector('g.k') as Element

  it('sizes the figure for the video, and stops what the page animates', () => {
    const root = fresh()
    expect(root.getAttribute('width')).toBe('1200')
    expect(root.querySelector('style')?.textContent).toContain('animation:none!important')
  })

  it('brings the boxes and lines in on the first scene', () => {
    const root = fresh()
    paint(root, figure, 0, 0)
    expect(box(root, 0).querySelector('.in')?.getAttribute('opacity')).toBe('0')
    expect(key(root).querySelector('.base')?.getAttribute('opacity')).toBe('0')
    paint(root, figure, 0, 5000)
    expect(box(root, 0).querySelector('.in')?.getAttribute('opacity')).toBe('1')
    expect(key(root).querySelector('.base')?.getAttribute('opacity')).toBe('1')
  })

  it("does not fade from the scene before a chapter's first: what is not lit is faint from the start", () => {
    const root = fresh()
    paint(root, figure, 1, 0, 1)
    expect(box(root, 2).getAttribute('opacity')).toBe('0.3')
  })

  it('lights by tone, fades the rest over a moment, marks columns and shows the badge', () => {
    const root = fresh()
    paint(root, figure, 1, 0)
    expect(box(root, 2).getAttribute('opacity')).toBe('1')
    paint(root, figure, 1, 1000)
    expect(box(root, 0).getAttribute('class')).toBe('t tone-focus')
    expect(box(root, 1).getAttribute('class')).toBe('t tone-index')
    expect(box(root, 2).getAttribute('class')).toBe('t')
    expect([box(root, 0), box(root, 2)].map((g) => g.getAttribute('opacity'))).toEqual(['1', '0.3'])
    expect(box(root, 1).querySelector('.c')?.getAttribute('class')).toBe('c on')
    const badge = box(root, 0).querySelector('.badge')
    expect(badge?.hasAttribute('display')).toBe(false)
    expect(badge?.textContent).toBe('2')
    expect(box(root, 1).querySelector('.badge')?.getAttribute('display')).toBe('none')
  })

  it('flows a key its way five times and then stops, and rings a box twice', () => {
    const root = fresh()
    paint(root, figure, 1, 450)
    expect(key(root).getAttribute('class')).toBe('k tone-focus flow')
    expect(key(root).querySelector('.fl')?.getAttribute('stroke-dashoffset')).toBe('16')
    expect(root.querySelectorAll('#rings rect')).toHaveLength(1)
    paint(root, figure, 1, 60_000)
    expect(key(root).querySelector('.fl')?.getAttribute('stroke-dashoffset')).toBe('160')
    expect(root.querySelectorAll('#rings rect')).toHaveLength(0)
  })
})

/** A pen whose every character is 10 wide. */
const pen = { measureText: (s: string) => ({ width: [...s].length * 10 }) as TextMetrics }

describe('wrap', () => {
  it('keeps a name whole, breaks Japanese anywhere, and never starts a line with closing punctuation', () => {
    expect(wrap(pen, 'refers to order_items now', 120)).toEqual(['refers to', 'order_items', 'now'])
    expect(wrap(pen, 'あいうえおかきくけこさ', 50)).toEqual(['あいうえお', 'かきくけこ', 'さ'])
    expect(wrap(pen, 'あいうえお。かき', 50)).toEqual(['あいうえお。', 'かき'])
    expect(wrap(pen, 'これは users です', 100)).toEqual(['これは users', 'です'])
  })

  it('cuts a word wider than a line where it must', () => {
    expect(wrap(pen, 'abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('takes an opening bracket down with what it opens', () => {
    expect(wrap(pen, 'あいう（えお）', 40)).toEqual(['あいう', '（えお）'])
  })

  it('cuts a line too wide, with "…" at its end', () => {
    expect(fitLine(pen, 'abcdefghij', 50)).toBe('abcd…')
    expect(fitLine(pen, 'abc', 50)).toBe('abc')
  })
})

/** A canvas context that records what is written, and how large. */
function fakeContext() {
  const written: { text: string; font: string; colour: string }[] = []
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    measureText: (s: string) => ({
      width: [...s].length * (Number(/(\d+(\.\d+)?)px/.exec(ctx.font)?.[1]) || 10) * 0.6,
    }),
    fillText: (text: string) => written.push({ text, font: ctx.font, colour: String(ctx.fillStyle) }),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
  }
  return { ctx, written }
}

describe('drawWords', () => {
  it('writes the scene, its title and words, then what it says of the design and where it costs time', () => {
    const { ctx, written } = fakeContext()
    drawWords(ctx as unknown as CanvasRenderingContext2D, figure.scenes[1] as FigureScene, words)
    const texts = written.map((w) => w.text)
    expect(texts.slice(0, 2)).toEqual(['2 / 2', 'orders refer to users'])
    expect(texts).toEqual(expect.arrayContaining(['Design', '•', 'why it is so', 'Hints', 'where it costs time']))
    expect(written.find((w) => w.text === 'Hints')?.colour).toBe('#b42318')
  })

  it('sets a scene that says much smaller, so it fits', () => {
    const { ctx, written } = fakeContext()
    const long = { ...(figure.scenes[1] as FigureScene), notes: Array.from({ length: 12 }, () => 'y'.repeat(120)) }
    drawWords(ctx as unknown as CanvasRenderingContext2D, long, words)
    expect(written.find((w) => w.text === long.title)?.font).not.toContain('28px')
  })

  it('ends with "…" where even the smallest size does not hold it all, and writes nothing below', () => {
    const { ctx, written } = fakeContext()
    const long = {
      ...(figure.scenes[1] as FigureScene),
      notes: Array.from({ length: 40 }, (_, i) => `note ${i} ${'y'.repeat(200)}`),
    }
    drawWords(ctx as unknown as CanvasRenderingContext2D, long, words)
    expect(written.at(-1)?.text).toMatch(/…$/)
    expect(written.some((w) => w.text === 'Hints')).toBe(false)
  })
})

describe('videoType', () => {
  it('records MP4 where it can, WebM otherwise, and nothing where neither', () => {
    expect(videoType(() => true)).toEqual({ mime: 'video/mp4;codecs=avc1', ext: 'mp4' })
    expect(videoType((t) => t.startsWith('video/webm'))).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' })
    expect(videoType(() => false)).toBeUndefined()
  })
})

describe('recordTour', () => {
  let recorders: FakeRecorder[]
  class FakeRecorder {
    static isTypeSupported = (t: string) => t === 'video/webm'
    state = 'inactive'
    ondataavailable: ((e: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    constructor(
      readonly stream: unknown,
      readonly options: { mimeType: string }
    ) {
      recorders.push(this)
    }
    start() {
      this.state = 'recording'
    }
    onerror: ((e: Event & { error?: unknown }) => void) | null = null
    stop() {
      // As in a browser: a recorder that has stopped does not stop again.
      if (this.state === 'inactive') throw new DOMException('not recording', 'InvalidStateError')
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['frames']) })
      this.onstop?.()
    }
    /** The encoder fails: the recorder stops by itself and says why. */
    fail() {
      this.state = 'inactive'
      this.onerror?.(Object.assign(new Event('error'), { error: new Error('encoder') }))
    }
  }
  const track = { stop: vi.fn() }

  beforeEach(() => {
    recorders = []
    track.stop.mockClear()
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => fakeContext().ctx as unknown as CanvasRenderingContext2D
    )
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: () => ({ getTracks: () => [track] }),
    })
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: () => Promise.resolve() })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
    Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
  })

  /** A clock that moves on 100 ms each time the recording waits. */
  const clock = () => {
    let now = 0
    return {
      now: () => now,
      wait: async () => {
        now += 100
      },
    }
  }

  it('draws every scene in turn, in the kind of file the browser records, and stops the recorder', async () => {
    const reached: number[] = []
    const made = await recordTour(figure, words, {
      signal: new AbortController().signal,
      onScene: (i) => reached.push(i),
      clock: clock(),
    })
    expect(reached).toEqual([0, 1])
    expect(made.ext).toBe('webm')
    expect(made.blob.type).toBe('video/webm')
    expect(made.blob.size).toBeGreaterThan(0)
    expect(recorders[0]?.state).toBe('inactive')
    expect(track.stop).toHaveBeenCalled()
  })

  it('records a chapter only: its scenes, for its time', async () => {
    const { starts, total } = timeline(figure.scenes)
    const run = async (range: { from: number; to: number }) => {
      const reached: number[] = []
      const time = clock()
      await recordTour(figure, words, {
        signal: new AbortController().signal,
        onScene: (i) => reached.push(i),
        clock: time,
        range,
      })
      return { reached, took: time.now() }
    }
    const opening = await run({ from: 0, to: 1 })
    expect(opening.reached).toEqual([0])
    expect(opening.took).toBeGreaterThanOrEqual((starts[1] ?? 0) - 100)
    expect(opening.took).toBeLessThan((starts[1] ?? 0) + 100)
    const rest = await run({ from: 1, to: 2 })
    expect(rest.reached).toEqual([1])
    expect(rest.took).toBeGreaterThanOrEqual(total - (starts[1] ?? 0))
    expect(rest.took).toBeLessThan(total - (starts[1] ?? 0) + 200)
  })

  it('ends at a failing encoder, says why, and lets the canvas go', async () => {
    const made = recordTour(figure, words, {
      signal: new AbortController().signal,
      onScene: (i) => {
        if (i === 1) recorders[0]?.fail()
      },
      clock: clock(),
    })
    await expect(made).rejects.toThrow('encoder')
    expect(track.stop).toHaveBeenCalled()
  })

  it('does not save what a recorder that stopped by itself before the end made', async () => {
    const made = recordTour(figure, words, {
      signal: new AbortController().signal,
      onScene: (i) => {
        if (recorders[0] && i === 1) recorders[0].state = 'inactive'
      },
      clock: clock(),
    })
    await expect(made).rejects.toThrow('stopped early')
    expect(track.stop).toHaveBeenCalled()
  })

  it('does not start when stopped before it began', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(
      recordTour(figure, words, { signal: stop.signal, onScene: vi.fn(), clock: clock() })
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(recorders).toHaveLength(0)
  })

  it('makes nothing when stopped, and lets the recorder go', async () => {
    const stop = new AbortController()
    const made = recordTour(figure, words, { signal: stop.signal, onScene: () => stop.abort(), clock: clock() })
    await expect(made).rejects.toMatchObject({ name: 'AbortError' })
    expect(recorders[0]?.state).toBe('inactive')
    expect(track.stop).toHaveBeenCalled()
  })
})
