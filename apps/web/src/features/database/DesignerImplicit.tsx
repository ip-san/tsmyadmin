import { useQueries } from '@tanstack/react-query'
import type { Namespace, RelationDef } from '@tsmyadmin/shared'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import type { DiagramOverlay } from '@/components/schema-diagram/overlay.ts'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { structureQuery } from '@/lib/queries.ts'
import { implicitRelations } from './implicit-relations.ts'

const t = locale.designer.implicit

/** The columns the candidates start from, by table: lit in their boxes. */
function columnsOf(relations: readonly RelationDef[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of relations) out.set(r.table, new Set([...(out.get(r.table) ?? []), ...r.columns]))
  return out
}

/**
 * The references the schema keeps by name only (`<name>_id` with no foreign key), while asked for: drawn as dotted
 * lines (candidates, not keys), and listed under the diagram, each with a button that hands it to the form that
 * adds a foreign key (which shows the statement before it runs). Reads every table's columns, as listing every
 * column does (the same queries, so one reads for the other).
 */
export function useImplicit({
  db,
  schema,
  ns,
  names,
  keys,
  on,
  onMakeKey,
}: {
  db: string
  schema: string | undefined
  ns: Namespace
  names: readonly string[]
  keys: readonly RelationDef[] | undefined
  on: boolean
  onMakeKey: (candidate: RelationDef) => void
}) {
  const structures = useQueries({
    queries: names.map((table) => ({ ...structureQuery({ db, schema, table }), enabled: on })),
  })
  if (!on) return { relations: [] as RelationDef[], overlay: undefined, panel: null }
  if (structures.some((s) => s.isPending))
    return { relations: [], overlay: undefined, panel: <Spinner label={t.reading} /> }
  const shapes = structures.flatMap((s) =>
    s.data ? [{ name: s.data.name, columns: s.data.columns.map((c) => c.name), primaryKey: s.data.primaryKey }] : []
  )
  const relations = implicitRelations(shapes, keys ?? [], ns)
  const overlay: DiagramOverlay = {
    tables: new Map(),
    relations: new Map(relations.map((r) => [relationKey(r), 'blocked'] as const)),
    columns: columnsOf(relations),
    fade: false,
  }
  const failed = structures.filter((s) => s.isError).length
  const panel = (
    <section aria-label={t.title} className="space-y-1 print:hidden">
      <h3 className="text-sm font-semibold text-ink">{t.title}</h3>
      <DiagramLegend tones={['blocked']} labels={{ blocked: t.legend }} />
      <p className="text-xs text-ink-sub">{t.hint}</p>
      {failed > 0 ? <p className="text-xs text-ink-sub">{t.failed(failed)}</p> : null}
      {relations.length === 0 ? (
        <p className="text-sm text-ink-sub">{t.none}</p>
      ) : (
        <ul className="space-y-1 text-sm text-ink">
          {relations.map((r) => (
            <li key={relationKey(r)} className="flex flex-wrap items-center gap-2">
              <span>{t.candidate(r.table, r.columns[0] ?? '', r.refTable, r.refColumns[0] ?? '')}</span>
              <Button size="sm" aria-haspopup="dialog" onClick={() => onMakeKey(r)}>
                {t.makeKey}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
  return { relations, overlay, panel }
}
