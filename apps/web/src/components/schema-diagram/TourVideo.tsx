import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import { downloadBlob, safeFilename } from '@/lib/download.ts'
import type { Tone } from './overlay.ts'
import { readMs, type TourScene } from './tour.ts'
import type { TourDiagram } from './tour-figure.ts'

const t = locale.tour

/** Whether this browser records a canvas as a video. */
const canRecord = () =>
  typeof MediaRecorder !== 'undefined' &&
  'captureStream' in HTMLCanvasElement.prototype &&
  ['video/mp4', 'video/webm'].some((type) => MediaRecorder.isTypeSupported(type))

type State = { scene: number } | 'recorded' | 'stopped' | 'failed' | null

/**
 * Saves the tour as a video with its words on it (`recordTour`, read when asked for). Recording takes as long as the
 * video; while it goes, a second button stops it and the line beside says how far it has come. Not shown where the
 * browser cannot record.
 */
export function TourVideo({
  title,
  drawn,
  tones,
}: {
  title: string
  drawn: { diagram: TourDiagram; scenes: readonly TourScene[] }
  tones: Partial<Record<Tone, string>>
}) {
  const [state, setState] = useState<State>(null)
  // Set at once on the press: a second press in the same frame does not start a second recording.
  const busy = useRef<AbortController | null>(null)
  // Where the focus goes back when the stop button, pressed, goes away.
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => () => busy.current?.abort(), [])
  if (!canRecord()) return null
  const seconds = Math.round(drawn.scenes.reduce((sum, s) => sum + readMs(s), 0) / 1000)
  const record = async () => {
    if (busy.current) return
    const stop = new AbortController()
    busy.current = stop
    setState({ scene: 1 })
    try {
      const [{ tourFigure }, { recordTour }] = await Promise.all([
        import('./tour-figure.ts'),
        import('./tour-video.ts'),
      ])
      // Stopped while the recorder was being read: it does not start.
      stop.signal.throwIfAborted()
      const figure = tourFigure(drawn.diagram, drawn.scenes, { sceneOf: t.sceneOf, stop: t.stop })
      const { blob, ext } = await recordTour(
        figure,
        { title, notes: t.notes, hints: t.hints, tones },
        { signal: stop.signal, onScene: (i) => setState({ scene: i + 1 }) }
      )
      downloadBlob(safeFilename(title, ext), blob)
      setState('recorded')
    } catch {
      // Stopped by hand (or the dialog closed), or the browser could not.
      if (busy.current === stop) setState(stop.signal.aborted ? 'stopped' : 'failed')
    } finally {
      if (busy.current === stop) busy.current = null
    }
  }
  const recording = typeof state === 'object' && state !== null
  let said = ''
  if (recording) said = t.recording(state.scene, drawn.scenes.length, seconds)
  else if (state === 'recorded') said = t.recorded
  else if (state === 'stopped') said = t.videoStopped
  else if (state === 'failed') said = t.videoFailed
  return (
    <>
      <p role="status" className="self-center text-xs text-ink empty:sr-only">
        {said}
      </p>
      {recording ? (
        <Button
          size="sm"
          onClick={() => {
            busy.current?.abort()
            button.current?.focus()
          }}
        >
          {t.stopVideo}
        </Button>
      ) : null}
      <Button
        ref={button}
        size="sm"
        title={t.videoHint(seconds)}
        aria-disabled={recording || undefined}
        onClick={() => void record()}
      >
        {t.video}
      </Button>
    </>
  )
}
