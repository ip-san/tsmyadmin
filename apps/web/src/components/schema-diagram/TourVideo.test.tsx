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
    await vi.waitFor(() => expect(recording.recordTour).toHaveBeenCalled())
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
})
