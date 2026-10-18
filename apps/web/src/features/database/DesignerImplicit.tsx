import type { Namespace, RelationDef } from '@tsmyadmin/shared'
import { relationKey } from '@/components/schema-diagram/layout.ts'
import type { DiagramOverlay } from '@/components/schema-diagram/overlay.ts'
import { DiagramLegend } from '@/components/schema-diagram/StepNarration.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { useAllStructures } from '@/lib/use-all-structures.ts'
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
  // The same reading as the Designer's "all columns" (one shared query): turning both on reads the tables once.
  const structures = useAllStructures(db, schema, names, { enabled: on })
  if (!on) return { relations: [] as RelationDef[], overlay: undefined, panel: () => null }
  if (structures.isError)
    return {
      relations: [],
      overlay: undefined,
      panel: () => <ErrorBox error={structures.error} onRetry={() => void structures.refetch()} />,
    }
  if (!structures.data) return { relations: [], overlay: undefined, panel: () => <Spinner label={t.reading} /> }
  const shapes = [...structures.data.byName.values()].map((s) => ({
    name: s.name,
    columns: s.columns.map((c) => c.name),
    primaryKey: s.primaryKey,
  }))
  const relations = implicitRelations(shapes, keys ?? [], ns)
  const overlay: DiagramOverlay = {
    tables: new Map(),
    relations: new Map(relations.map((r) => [relationKey(r), 'blocked'] as const)),
    columns: columnsOf(relations),
    fade: false,
  }
  const failed = structures.data.failed.length
  /** The list under the diagram: the candidates between the tables drawn (the lines there are), and how many more. */
  const panel = (drawn: readonly string[]) => {
    const listed = relations.filter((r) => drawn.includes(r.table) && drawn.includes(r.refTable))
    return (
      <section aria-label={t.title} className="space-y-1 print:hidden">
        <h3 className="text-sm font-semibold text-ink">{t.title}</h3>
        <DiagramLegend tones={['blocked']} labels={{ blocked: t.legend }} />
        <p className="text-xs text-ink-sub">{t.hint}</p>
        {failed > 0 ? <p className="text-xs text-ink-sub">{t.failed(failed)}</p> : null}
        {listed.length < relations.length ? (
          <p className="text-xs text-ink-sub">{t.notDrawn(relations.length - listed.length)}</p>
        ) : null}
        {relations.length === 0 ? (
          <p className="text-sm text-ink-sub">{t.none}</p>
        ) : (
          <ul className="space-y-1 text-sm text-ink">
            {listed.map((r) => (
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
  }
  return { relations, overlay, panel }
}
