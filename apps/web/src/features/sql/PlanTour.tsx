import type { PlanNode, RelationDef } from '@tsmyadmin/shared'
import { Presentation } from 'lucide-react'
import { useState } from 'react'
import { TourDialog } from '@/components/schema-diagram/TourDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale-screens.ts'
import { planTour } from './plan-tour.ts'

const t = locale.planTour

/** "Present": the plan drawn beside it, told scene by scene in the order the server runs it (`planTour`). */
export function PlanTour({
  plan,
  relations,
  indexColumns,
}: {
  plan: PlanNode
  relations: readonly RelationDef[]
  indexColumns: (table: string, index: string) => readonly string[]
}) {
  // Told as it was when it opened: the index columns read in after do not move the scenes under it.
  const [drawn, setDrawn] = useState<ReturnType<typeof planTour> | null>(null)
  return (
    <>
      <Button size="sm" title={t.openHint} onClick={() => setDrawn(planTour({ plan, relations, indexColumns }))}>
        <Presentation className="size-4" aria-hidden />
        {t.open}
      </Button>
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
    </>
  )
}
