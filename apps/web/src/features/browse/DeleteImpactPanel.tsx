import { useQuery } from '@tanstack/react-query'
import type { DeleteImpact, RelationDef, RowKey } from '@tsmyadmin/shared'
import { diagramFor, overlayUpTo } from '@/components/schema-diagram/overlay.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { DiagramLegend, StepNarration } from '@/components/schema-diagram/StepNarration.tsx'
import { useStepPlayer } from '@/components/schema-diagram/use-step-player.ts'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'
import { deleteImpactQuery, foreignKeysQuery, type TableRef } from '@/lib/queries.ts'
import { impactRelations, impactSteps, impactTables } from './delete-impact.ts'

const t = locale.deleteImpact

/**
 * What deleting the chosen rows would reach, counted on the server without deleting: the tables drawn alone, lit
 * depth by depth, with the same story in words beside it. Opened from the delete dialog, before the delete.
 */
export function DeleteImpactPanel({ tableRef, keys }: { tableRef: TableRef; keys: RowKey[] }) {
  const impact = useQuery(deleteImpactQuery(tableRef, keys))
  const relations = useQuery(foreignKeysQuery(tableRef.db, tableRef.schema))
  if (impact.isPending || relations.isPending) return <Spinner label={t.loading} />
  if (impact.isError) return <ErrorBox error={impact.error} onRetry={() => void impact.refetch()} />
  if (relations.isError) return <ErrorBox error={relations.error} onRetry={() => void relations.refetch()} />
  if (impact.data.rows === 0) return <Notice>{t.noRows}</Notice>
  return <ImpactStory impact={impact.data} relations={relations.data} />
}

function ImpactStory({ impact, relations }: { impact: DeleteImpact; relations: readonly RelationDef[] }) {
  const steps = impactSteps(impact)
  const player = useStepPlayer(steps.length)
  const diagram = diagramFor(impactTables(impact), impactRelations(impact, relations))
  return (
    <section aria-label={t.title} className="mt-3 space-y-3">
      {impact.blocked ? (
        <p role="alert" className="rounded border border-critical-border bg-critical-sub p-2 text-sm text-critical">
          {t.blocked}
        </p>
      ) : null}
      {impact.steps.length === 0 ? <Notice>{t.noKeys}</Notice> : null}
      {impact.capped ? <Notice>{t.capped}</Notice> : null}
      <SchemaDiagram {...diagram} overlay={overlayUpTo(steps, player.index)} label={t.diagram} />
      <DiagramLegend tones={['focus', 'delete', 'nullify', 'blocked']} />
      <StepNarration steps={steps} player={player} />
      <p className="text-xs text-ink-sub">{t.notes}</p>
    </section>
  )
}
