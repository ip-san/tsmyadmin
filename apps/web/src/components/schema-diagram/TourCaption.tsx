import { useId } from 'react'
import { locale } from '@/config/locale-screens.ts'
import type { TourScene } from './tour.ts'

const t = locale.tour

/**
 * The words of a scene, read out as it changes: which scene, its title and words, what it says of the design, and
 * where the design may cost time. Beside the picture on a wide screen; it scrolls (and takes the keyboard, to be
 * scrolled) when a scene says more than fits.
 */
export function TourCaption({
  scene,
  index,
  count,
  notesTitle = t.notes,
}: {
  scene: TourScene
  index: number
  count: number
  notesTitle?: string
}) {
  const titleId = useId()
  return (
    <section
      aria-live="polite"
      aria-atomic
      aria-labelledby={titleId}
      tabIndex={0}
      className="min-h-36 shrink-0 space-y-1 overflow-y-auto lg:max-h-full lg:w-[28rem]"
    >
      <p className="text-sm text-ink-sub">{t.sceneOf(index + 1, count)}</p>
      <h3 id={titleId} className="text-2xl font-bold text-ink">
        {scene.title}
      </h3>
      <p className="text-lg text-ink">{scene.text}</p>
      <SceneList title={notesTitle} items={scene.notes} className="text-brand" />
      <SceneList title={t.hints} items={scene.hints} className="text-critical" />
    </section>
  )
}

/** What a scene says beyond its words, under a heading of its own: nothing when it says nothing. */
function SceneList({
  title,
  items,
  className,
}: {
  title: string
  items: readonly string[] | undefined
  className: string
}) {
  if (!items || items.length === 0) return null
  return (
    <section aria-label={title} className="pt-1">
      <h4 className={`text-sm font-semibold ${className}`}>{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-base text-ink">
        {items.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </section>
  )
}
