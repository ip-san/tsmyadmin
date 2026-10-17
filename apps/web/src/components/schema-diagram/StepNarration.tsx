import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import { type OverlayStep, TONE_STROKE, TONES, type Tone } from './overlay.ts'
import type { useStepPlayer } from './use-step-player.ts'

const t = locale.schemaDiagram

/**
 * The same story as the diagram, in words: every step listed, the current one marked and read out. This is what a
 * screen reader follows, and what anyone reads when the picture moves too fast; a step is picked to jump to it.
 */
export function StepNarration({
  steps,
  player,
}: {
  steps: readonly OverlayStep[]
  player: ReturnType<typeof useStepPlayer>
}) {
  const current = steps[player.index]
  const atEnd = player.index >= steps.length - 1
  return (
    <section aria-label={t.steps} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={player.first} disabled={player.index === 0}>
          {t.first}
        </Button>
        <Button size="sm" onClick={player.prev} disabled={player.index === 0}>
          {t.prev}
        </Button>
        <Button size="sm" aria-pressed={player.playing} onClick={player.playing ? player.pause : player.play}>
          {player.playing ? t.pause : t.play}
        </Button>
        <Button size="sm" onClick={player.next} disabled={atEnd}>
          {t.next}
        </Button>
        <Button size="sm" onClick={player.last} disabled={atEnd}>
          {t.last}
        </Button>
        <span className="text-xs text-ink-sub">{t.stepOf(player.index + 1, steps.length)}</span>
      </div>
      <p aria-live="polite" className="sr-only">
        {current?.text}
      </p>
      <ol className="space-y-1 text-sm">
        {steps.map((step, i) => (
          <li key={i}>
            <button
              type="button"
              aria-current={i === player.index ? 'step' : undefined}
              onClick={() => player.goTo(i)}
              className={`w-full rounded px-2 py-1 text-left ${stepClass(i, player.index)}`}
            >
              {i + 1}. {step.text}
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** The current step stands out; those already shown read as text, those still to come fainter. */
const stepClass = (i: number, current: number) =>
  i === current ? 'bg-row-hover font-semibold text-ink' : i < current ? 'text-ink' : 'text-ink-sub'

/** What each outline means: colour, and the width and dashes that say the same without it. */
export function DiagramLegend({
  tones = TONES,
  labels = {},
}: {
  tones?: readonly Tone[]
  /** What a tone means on this diagram, where it says something else than the usual word. */
  labels?: Partial<Record<Tone, string>>
}) {
  return (
    <figure className="text-xs text-ink-sub">
      <figcaption className="sr-only">{t.legend}</figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {tones.map((tone) => (
          <li key={tone} className="flex items-center gap-1">
            <svg width={28} height={12} aria-hidden>
              <line
                x1={2}
                x2={26}
                y1={6}
                y2={6}
                className={TONE_STROKE[tone].className}
                strokeWidth={TONE_STROKE[tone].width}
                strokeDasharray={TONE_STROKE[tone].dash}
              />
            </svg>
            {labels[tone] ?? t.tones[tone]}
          </li>
        ))}
      </ul>
    </figure>
  )
}
