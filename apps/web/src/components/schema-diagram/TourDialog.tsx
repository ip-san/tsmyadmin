import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { localeCode } from '@/config/locale.ts'
import { locale } from '@/config/locale-screens.ts'
import { downloadText, safeFilename } from '@/lib/download.ts'
import { frameOf } from './camera.ts'
import { BOX_WIDTH, boxHeight } from './layout.ts'
import { type diagramFor, TONES, type Tone } from './overlay.ts'
import { SceneBar } from './SceneBar.tsx'
import { SchemaDiagram } from './SchemaDiagram.tsx'
import { DiagramLegend } from './StepNarration.tsx'
import { TourCaption } from './TourCaption.tsx'
import { TourVideo } from './TourVideo.tsx'
import { spoken, type TourScene } from './tour.ts'
import { useCamera } from './use-camera.ts'
import { useReading, useVoice } from './use-narration.ts'
import { useStepPlayer } from './use-step-player.ts'

const t = locale.tour
const FIELDS = [HTMLSelectElement, HTMLInputElement, HTMLTextAreaElement]
/** How long a scene stays, while playing: long enough to read its words aloud. */
const SCENE_MS = 6000
/** Around a box the ring is drawn, as the scene opens. */
const RING = 8

type TourDiagram = ReturnType<typeof diagramFor>

/**
 * A diagram told as a presentation, on the whole screen: drawn once, with a camera moving over it scene by scene
 * while the words for each are shown large and read out. It plays on its own; the arrow keys, Page Up / Down (a
 * presenter's clicker) and the space bar move by hand, P plays and pauses, and F fills the screen. Until `drawn` is
 * there it says it is reading (or, with `error`, why it could not).
 */
export function TourDialog({
  title,
  label,
  drawn,
  tones,
  error,
  saveHint = t.saveHint,
  notesTitle = t.notes,
  controls,
  onClose,
}: {
  title: string
  /** What the diagram is, for a screen reader. */
  label: string
  drawn: { diagram: TourDiagram; scenes: readonly TourScene[] } | undefined
  /** What each colour means on this tour (`DiagramLegend`). */
  tones: Partial<Record<Tone, string>>
  error?: { error: unknown; retry: () => void } | undefined
  /** What the saved file holds, said on its button (names and comments, unless the tour says more). */
  saveHint?: string
  /** The heading of what a scene says beyond its words: what it reads of the design, unless the tour reads else. */
  notesTitle?: string
  /** More for the header, before saving (counting the rows, say). */
  controls?: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // The scene's keys, set by the stage once there is one: they work wherever the focus is in the dialog.
  const keysRef = useRef<((e: KeyboardEvent) => void) | null>(null)
  const titleId = useId()
  useEffect(() => {
    const el = ref.current
    // The button that opened it gets the focus back: Chromium does this when a dialog closes, WebKit does not.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (el && !el.open) el.showModal()
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen()
      opener?.focus()
    }
  }, [])
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void ref.current?.requestFullscreen?.()
  }
  let body: ReactNode
  if (error) body = <ErrorBox error={error.error} onRetry={error.retry} />
  else if (drawn)
    body = (
      <Stage
        diagram={drawn.diagram}
        scenes={drawn.scenes}
        label={label}
        tones={tones}
        notesTitle={notesTitle}
        onFullscreen={toggleFullscreen}
        keysRef={keysRef}
      />
    )
  else
    body = (
      <p role="status" className="text-sm text-ink">
        {t.reading}
      </p>
    )
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onKeyDown={(e) => keysRef.current?.(e)}
      aria-labelledby={titleId}
      className="m-0 h-dvh max-h-none w-dvw max-w-none bg-canvas p-0 text-ink backdrop:bg-black/60"
    >
      <div className="flex h-full flex-col gap-3 p-4">
        <header className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-sm font-semibold text-ink-sub">
            {title}
          </h2>
          <div className="flex gap-2">
            {drawn && !error ? (
              <>
                {controls}
                <TourVideo title={title} drawn={drawn} tones={tones} notesTitle={notesTitle} />
                <Button size="sm" title={saveHint} onClick={() => void save(title, label, drawn, tones, notesTitle)}>
                  {t.save}
                </Button>
              </>
            ) : null}
            <Button size="sm" aria-pressed={fullscreen} onClick={toggleFullscreen}>
              {t.fullscreen}
            </Button>
            <Button size="sm" onClick={() => ref.current?.close()}>
              {t.close}
            </Button>
          </div>
        </header>
        {body}
      </div>
    </dialog>
  )
}

/** The tour as one HTML file that plays without the server (`tourHtml`, read when asked for: most never save). */
async function save(
  title: string,
  label: string,
  drawn: { diagram: TourDiagram; scenes: readonly TourScene[] },
  tones: Partial<Record<Tone, string>>,
  notesTitle: string
) {
  const { tourHtml } = await import('./tour-html.ts')
  const html = tourHtml(drawn.diagram, drawn.scenes, {
    lang: localeCode,
    title,
    label,
    prev: t.prev,
    next: t.next,
    play: t.play,
    pause: t.pause,
    narrate: t.narrate,
    noVoice: t.noVoice,
    notes: notesTitle,
    hints: t.hints,
    stop: t.stop,
    keys: t.savedKeys,
    sceneOf: t.sceneOf,
    inChapter: t.inChapter,
    tones,
  })
  downloadText(safeFilename(title, 'html'), html, 'text/html')
}

/** The diagram under the camera, the words of the scene, and the controls that move between scenes. */
function Stage({
  diagram,
  scenes,
  label,
  tones,
  notesTitle,
  onFullscreen,
  keysRef,
}: {
  diagram: TourDiagram
  scenes: readonly TourScene[]
  label: string
  tones: Partial<Record<Tone, string>>
  notesTitle: string
  onFullscreen: () => void
  keysRef: RefObject<((e: KeyboardEvent) => void) | null>
}) {
  const voice = useVoice(localeCode)
  // Read aloud, a scene lasts as long as its words: the next comes when they have been read.
  const player = useStepPlayer(scenes.length, SCENE_MS, { still: 'first', hold: voice.voice !== null })
  const scene = scenes[player.index] ?? scenes[0]
  const reading = useReading(voice, player, scene ? spoken(scene) : '', SCENE_MS)
  const at = (table: string) => diagram.positions[table] ?? { x: 0, y: 0 }
  const size = (table: string) => ({ width: BOX_WIDTH, height: boxHeight(diagram.columns.get(table)?.length ?? 0) })
  const camera = useCamera(frameOf(scene?.frame ?? [], diagram.tables, at, size))
  const toggle = reading.toggle
  // A clicker's Page Up / Down move the scenes from anywhere; a focused button or field keeps its own other keys.
  keysRef.current = (e: KeyboardEvent) => {
    if (FIELDS.some((f) => e.target instanceof f) && !e.key.startsWith('Page')) return
    const onButton = e.target instanceof HTMLButtonElement
    const move: Record<string, (() => void) | undefined> = {
      ArrowRight: player.next,
      PageDown: player.next,
      ArrowLeft: player.prev,
      PageUp: player.prev,
      Home: player.first,
      End: player.last,
      ' ': onButton ? undefined : player.next,
      p: toggle,
      f: onFullscreen,
    }
    const act = move[e.key.length === 1 ? e.key.toLowerCase() : e.key]
    if (!act || e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    act()
  }
  // The bar fills over the scene's time; read aloud, a scene has no set time.
  const timed = player.playing && voice.voice === null
  if (!scene) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* On a wide screen the words go beside the picture: a scene that says much does not shrink it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="min-h-0 flex-1">
            <SchemaDiagram
              {...diagram}
              overlay={scene.overlay}
              camera={camera}
              label={label}
              over={scene.pulse.map((table) => (
                <rect
                  key={`${player.index}.${table}`}
                  x={at(table).x - RING}
                  y={at(table).y - RING}
                  width={size(table).width + 2 * RING}
                  height={size(table).height + 2 * RING}
                  rx={10}
                  aria-hidden
                  className="diagram-pulse fill-none stroke-brand"
                  strokeWidth={4}
                />
              ))}
            />
          </div>
          {/* Only the colours this scene draws, named for what they mean on the tour. */}
          <DiagramLegend
            tones={TONES.filter(
              (tone) =>
                [...scene.overlay.tables.values()].some((x) => x.tone === tone) ||
                [...scene.overlay.relations.values()].includes(tone)
            )}
            labels={tones}
          />
        </div>
        <TourCaption scenes={scenes} index={player.index} notesTitle={notesTitle} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={player.prev} disabled={player.index === 0}>
          {t.prev}
        </Button>
        <Button size="sm" onClick={toggle}>
          {player.playing ? t.pause : t.play}
        </Button>
        <Button size="sm" onClick={player.next} disabled={player.index >= scenes.length - 1}>
          {t.next}
        </Button>
        <Button size="sm" aria-pressed={voice.asked} onClick={reading.narrate}>
          {t.narrate}
        </Button>
        <SceneBar
          scenes={scenes}
          index={player.index}
          playing={player.playing}
          timed={timed}
          sceneMs={SCENE_MS}
          goTo={player.goTo}
        />
        {/* There from the start (empty): heard when reading aloud is asked for and the device has no voice for it. */}
        <p role="status" className="w-full text-sm text-ink empty:sr-only">
          {voice.asked && voice.voice === null ? t.noVoice : ''}
        </p>
        <p className="w-full text-xs text-ink-sub">{t.keys}</p>
      </div>
    </div>
  )
}
