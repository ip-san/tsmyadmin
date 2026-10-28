import { locale } from '@/config/locale-screens.ts'
import { chapterStarts, type TourScene } from './tour.ts'

const t = locale.tour

/**
 * The bar of a presentation: a button for each scene that goes to it, filled up to the scene shown, the one shown
 * filling over its time while it plays (`timed`). Where there is more than one chapter, a wider gap opens before each.
 */
export function SceneBar({
  scenes,
  index,
  playing,
  timed,
  sceneMs,
  goTo,
}: {
  scenes: readonly TourScene[]
  index: number
  playing: boolean
  /** The scene shown fills over `sceneMs`: it plays with no voice to wait for. */
  timed: boolean
  sceneMs: number
  goTo: (index: number) => void
}) {
  const starts = new Set(chapterStarts(scenes))
  const opens = (i: number) => starts.has(i)
  return (
    <ol aria-label={t.scenes} className="flex min-w-48 flex-1 gap-1">
      {scenes.map((s, i) => (
        <li key={i} data-chapter-start={opens(i) || undefined} className={`flex-1 ${opens(i) ? 'ml-3' : ''}`}>
          <button
            type="button"
            aria-label={t.goTo(i + 1, s.title)}
            aria-current={i === index ? 'step' : undefined}
            onClick={() => goTo(i)}
            className="flex h-6 w-full items-center"
          >
            <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-line">
              {i < index ? <span className="absolute inset-0 bg-brand" /> : null}
              {i === index ? (
                <span
                  key={`${i}.${playing}`}
                  className={`absolute inset-0 origin-left bg-brand ${timed ? 'diagram-progress' : ''}`}
                  style={timed ? { animationDuration: `${sceneMs}ms` } : undefined}
                />
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}
