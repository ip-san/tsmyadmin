import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '@/config/locale-screens.ts'
import { relation } from '@/test/schema-fixtures.ts'
import { diagramFor } from './overlay.ts'
import { TourVideo } from './TourVideo.tsx'
import { readMs, type TourScene, whole } from './tour.ts'

const t = locale.tour

const download = vi.hoisted(() => ({ downloadBlob: vi.fn() }))
vi.mock('@/lib/download.ts', async (original) => ({ ...(await original<object>()), ...download }))

/** The recording, held open until the test says how it ends. */
const recording = vi.hoisted(() => ({
  recordTour: vi.fn(),
  end: undefined as ((made: { blob: Blob; ext: string } | Error) => void) | undefined,
}))
vi.mock('./tour-video.ts', () => ({ recordTour: recording.recordTour }))

const diagram = diagramFor(['users', 'orders'], [relation('orders', ['user_id'], 'users')])
const scenes: TourScene[] = [
  { title: 'shop', text: 'all of it', frame: [], overlay: whole(true), pulse: [] },
  { title: 'the end', text: 'that is all', frame: [], overlay: whole(false), pulse: [] },
]
const seconds = Math.round(scenes.reduce((sum, s) => sum + readMs(s), 0) / 1000)

describe('TourVideo', () => {
  beforeEach(() => {
    download.downloadBlob.mockReset()
    recording.recordTour.mockReset()
    recording.recordTour.mockImplementation(
      (_figure, _words, { signal, onScene }: { signal: AbortSignal; onScene: (i: number) => void }) =>
        new Promise((resolve, reject) => {
          onScene(0)
          recording.end = (made) => (made instanceof Error ? reject(made) : resolve(made))
          signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')))
        })
    )
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (type: string) => type === 'video/webm' })
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => null })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
  })

  const show = () => render(<TourVideo title="Map of shop" drawn={{ diagram, scenes }} tones={{}} />)
  const press = async () => {
    fireEvent.click(screen.getByRole('button', { name: t.video }))
    await screen.findByText(t.recording(1, 2, seconds))
    await act(() => vi.waitFor(() => expect(recording.recordTour).toHaveBeenCalled()))
  }

  it('is not offered where the browser cannot record', () => {
    vi.unstubAllGlobals()
    show()
    expect(screen.queryByRole('button', { name: t.video })).toBeNull()
  })

  it('says how long it takes, how far it has come, and saves the video under the tour title', async () => {
    show()
    expect(screen.getByRole('button', { name: t.video }).getAttribute('title')).toBe(t.videoHint(seconds))
    await press()
    expect(screen.getByRole('button', { name: t.video }).getAttribute('aria-disabled')).toBe('true')
    // A second press while it records starts nothing.
    fireEvent.click(screen.getByRole('button', { name: t.video }))
    expect(recording.recordTour).toHaveBeenCalledTimes(1)
    const blob = new Blob(['video'])
    await act(async () => recording.end?.({ blob, ext: 'webm' }))
    expect(download.downloadBlob).toHaveBeenCalledWith('Map_of_shop.webm', blob)
    expect(screen.getByRole('status').textContent).toBe(t.recorded)
    expect(screen.queryByRole('button', { name: t.stopVideo })).toBeNull()
  })

  it('stops by hand, saving nothing, saying so, and keeping the focus', async () => {
    show()
    await press()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.stopVideo })))
    expect(download.downloadBlob).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(t.videoStopped)
    // The stop button goes away: the focus is not dropped with it.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t.video }))
    expect(screen.getByRole('button', { name: t.video }).hasAttribute('aria-disabled')).toBe(false)
  })

  it('says so when the browser could not make the video', async () => {
    show()
    await press()
    await act(async () => recording.end?.(new Error('no encoder')))
    expect(screen.getByRole('status').textContent).toBe(t.videoFailed)
  })

  it('stops recording when it goes away (the dialog closed)', async () => {
    const { unmount } = show()
    await press()
    const signal = (recording.recordTour.mock.calls[0]?.[2] as { signal: AbortSignal } | undefined)?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
  })
  it('records the chapter chosen, for its time, under the tour title and the chapter', async () => {
    const parts: TourScene[] = [
      { ...(scenes[0] as TourScene), chapter: 'Roles' },
      { ...(scenes[1] as TourScene), chapter: 'Checks' },
    ]
    render(<TourVideo title="Map of shop" drawn={{ diagram, scenes: parts }} tones={{}} />)
    const chooser = screen.getByRole('combobox', { name: t.chapter })
    const second = Math.round(readMs(parts[1] as TourScene) / 1000)
    expect([...chooser.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      t.wholeVideo(seconds),
      t.chapterOption(1, 'Roles', Math.round(readMs(parts[0] as TourScene) / 1000)),
      t.chapterOption(2, 'Checks', second),
    ])
    fireEvent.change(chooser, { target: { value: '1' } })
    expect(screen.getByRole('button', { name: t.video }).getAttribute('title')).toBe(t.videoHint(second))
    fireEvent.click(screen.getByRole('button', { name: t.video }))
    await act(() => vi.waitFor(() => expect(recording.recordTour).toHaveBeenCalled()))
    const [, words, options] = recording.recordTour.mock.calls[0] as [unknown, { title: string }, { range?: unknown }]
    expect(options.range).toEqual({ from: 1, to: 2 })
    expect(words.title).toBe(t.chapterTitle('Map of shop', 2, 'Checks'))
    expect((chooser as HTMLSelectElement).disabled).toBe(true)
    const blob = new Blob(['video'])
    await act(async () => recording.end?.({ blob, ext: 'webm' }))
    expect(download.downloadBlob).toHaveBeenCalledWith('Map_of_shop_2_Checks.webm', blob)
  })

  it('offers no choice where the tour has no chapters, and records the whole', async () => {
    show()
    expect(screen.queryByRole('combobox')).toBeNull()
    await press()
    const [, , options] = recording.recordTour.mock.calls[0] as [unknown, unknown, { range?: unknown }]
    expect(options.range).toBeUndefined()
  })
})
