import { useQuery } from '@tanstack/react-query'
import { type KeyboardEvent, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react'
import { frameOf } from '@/components/schema-diagram/camera.ts'
import { BOX_WIDTH, boxHeight, drawnRelations } from '@/components/schema-diagram/layout.ts'
import { diagramFor, TONES } from '@/components/schema-diagram/overlay.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { useCamera } from '@/components/schema-diagram/use-camera.ts'
import { useStepPlayer } from '@/components/schema-diagram/use-step-player.ts'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { namespaceOf } from '@/lib/home-namespace.ts'
import { foreignKeysQuery, tablesQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import type { DatabaseMap } from './database-map.ts'
import type { JoinEnds } from './JoinPath.tsx'
import { joinPaths } from './join-path.ts'
import { type TourScene, tourScenes } from './map-tour.ts'

const t = locale.mapTour
/** How long a scene stays, while playing: long enough to read its words aloud. */
const SCENE_MS = 6000
/** Around a box the ring is drawn, as the scene opens. */
const RING = 8

/**
 * The map told as a presentation, on the whole screen: the database drawn once, and a camera moving over it scene by
 * scene (`tourScenes`) while the words for each are shown large and read out. It plays on its own; the arrow keys,
 * Page Up / Down (a presenter's clicker) and the space bar move by hand, and F fills the screen.
 */
export function MapTour({
  db,
  schema,
  map,
  ends,
  onClose,
}: {
  db: string
  schema: string | undefined
  map: DatabaseMap
  ends: JoinEnds
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // The scene's keys, set by the stage once there is one: they work wherever the focus is in the dialog.
  const keysRef = useRef<((e: KeyboardEvent) => void) | null>(null)
  const titleId = useId()
  const dialect = useDialect()
  const tables = useQuery(tablesQuery(db, schema))
  const keys = useQuery(foreignKeysQuery(db, schema))
  const name = schema ?? db
  // By name: the route gives a new object each render, and the layout of every table is not made again for it.
  const { from, to } = ends
  const drawn = useMemo(() => {
    if (!tables.data || !keys.data) return undefined
    const names = tables.data.filter((x) => x.kind === 'table').map((x) => x.name)
    const relations = drawnRelations(keys.data, dialect, namespaceOf(db, schema), names)
    const found = from && to && from !== to ? joinPaths(relations, from, to).paths[0] : undefined
    const path = from && to && found ? { from, to, hops: found } : undefined
    return { diagram: diagramFor(names, relations), scenes: tourScenes({ name, map, relations, path }) }
  }, [tables.data, keys.data, dialect, db, schema, from, to, name, map])

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

  const error = tables.isError ? tables : keys.isError ? keys : undefined
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
            {t.dialog(name)}
          </h2>
          <div className="flex gap-2">
            <Button size="sm" aria-pressed={fullscreen} onClick={toggleFullscreen}>
              {t.fullscreen}
            </Button>
            <Button size="sm" onClick={() => ref.current?.close()}>
              {t.close}
            </Button>
          </div>
        </header>
        {error ? (
          <ErrorBox error={error.error} onRetry={() => void error.refetch()} />
        ) : drawn ? (
          <Stage
            diagram={drawn.diagram}
            scenes={drawn.scenes}
            label={t.diagram(name)}
            onFullscreen={toggleFullscreen}
            keysRef={keysRef}
          />
        ) : (
          <p role="status" className="text-sm text-ink">
            {t.reading}
          </p>
        )}
      </div>
    </dialog>
  )
}

/** The diagram under the camera, the words of the scene, and the controls that move between scenes. */
function Stage({
  diagram,
  scenes,
  label,
  onFullscreen,
  keysRef,
}: {
  diagram: ReturnType<typeof diagramFor>
  scenes: readonly TourScene[]
  label: string
  onFullscreen: () => void
  keysRef: RefObject<((e: KeyboardEvent) => void) | null>
}) {
  const player = useStepPlayer(scenes.length, SCENE_MS, { still: 'first' })
  const scene = scenes[player.index] ?? scenes[0]
  const at = (table: string) => diagram.positions[table] ?? { x: 0, y: 0 }
  const size = (table: string) => ({ width: BOX_WIDTH, height: boxHeight(diagram.columns.get(table)?.length ?? 0) })
  const camera = useCamera(frameOf(scene?.frame ?? [], diagram.tables, at, size))
  const toggle = player.playing ? player.pause : player.play
  // A presenter's clicker sends Page Up / Down; a focused button keeps its own Space and Enter.
  keysRef.current = (e: KeyboardEvent) => {
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
  if (!scene) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
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
        labels={t.tones}
      />
      <section aria-live="polite" aria-atomic className="min-h-36 space-y-1">
        <p className="text-sm text-ink-sub">{t.sceneOf(player.index + 1, scenes.length)}</p>
        <h3 className="text-2xl font-bold text-ink">{scene.title}</h3>
        <p className="text-lg text-ink">{scene.text}</p>
      </section>
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
        <ol aria-label={t.scenes} className="flex min-w-48 flex-1 gap-1">
          {scenes.map((s, i) => (
            <li key={i} className="flex-1">
              <button
                type="button"
                aria-label={t.goTo(i + 1, s.title)}
                aria-current={i === player.index ? 'step' : undefined}
                onClick={() => player.goTo(i)}
                className="flex h-6 w-full items-center"
              >
                <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-line">
                  {i < player.index ? <span className="absolute inset-0 bg-brand" /> : null}
                  {i === player.index ? (
                    <span
                      key={`${i}.${player.playing}`}
                      className={`absolute inset-0 origin-left bg-brand ${player.playing ? 'diagram-progress' : ''}`}
                      style={player.playing ? { animationDuration: `${SCENE_MS}ms` } : undefined}
                    />
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <p className="w-full text-xs text-ink-sub">{t.keys}</p>
      </div>
    </div>
  )
}
