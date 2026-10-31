import type { PlanNode, RelationDef } from '@tsmyadmin/shared'
import { Presentation } from 'lucide-react'
import { useState } from 'react'
import { TourDialog } from '@/components/schema-diagram/TourDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import type { RowEstimates } from '@/lib/row-estimates.ts'
import { planTour } from './plan-tour.ts'
import type { TrialInput } from './plan-tour-trial.ts'

const t = locale.planTour

/** "Present": the plan drawn beside it, told scene by scene in the order the server runs it (`planTour`). */
export function PlanTour({
  plan,
  relations,
  indexColumns,
  rows,
  measuredMs,
  trial,
  ready,
}: {
  plan: PlanNode
  relations: readonly RelationDef[]
  indexColumns: (table: string, index: string) => readonly string[]
  /** The tables' estimated rows, where the list of tables could be read. */
  rows?: RowEstimates | undefined
  /** The plan was measured by running it: the time of the run (null where the server does not say). */
  measuredMs?: number | null | undefined
  /** An index tried: the plan is the run after it, told beside the run before. */
  trial?: TrialInput | undefined
  /**
   * The tables' index columns and estimated rows are read: until then the scenes would not have them, and they are
   * told as opened.
   */
  ready: boolean
}) {
  // Told as it was when it opened: the index columns read in after do not move the scenes under it.
  const [drawn, setDrawn] = useState<ReturnType<typeof planTour> | null>(null)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        title={t.openHint}
        disabled={!ready}
        onClick={() => setDrawn(planTour({ plan, relations, indexColumns, rows, measuredMs, trial }))}
      >
        <Presentation className="size-4" aria-hidden />
        {t.open}
      </Button>
      {/* There from the start, empty once read: why the button waits is shown and read out. */}
      <span role="status" className="text-xs text-ink-sub">
        {ready ? '' : t.waiting}
      </span>
      {drawn ? (
        <TourDialog
          title={t.dialog}
          label={t.diagram}
          drawn={drawn}
          tones={t.tones}
          saveHint={t.saveHint}
          notesTitle={t.notesTitle}
          onClose={() => setDrawn(null)}
        />
      ) : null}
    </div>
  )
}
