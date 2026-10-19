import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { drawnRelations, relationKey } from '@/components/schema-diagram/layout.ts'
import { type DiagramOverlay, diagramFor } from '@/components/schema-diagram/overlay.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale-screens.ts'
import { namespaceOf } from '@/lib/home-namespace.ts'
import { foreignKeysQuery, tablesQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { type JoinHop, joinPaths, QUERY_TABLES_LIMIT } from './join-path.ts'

const t = locale.joinPath

/** The two tables a path is asked between; either may not be chosen yet. */
export interface JoinEnds {
  from: string | undefined
  to: string | undefined
}

/**
 * How two tables are joined: the shortest paths between them along foreign keys (`joinPaths`), drawn and told one
 * step at a time, each with a link to the Query tab with its tables ticked. The two are kept in the URL (`ends`).
 */
export function JoinPath({
  db,
  schema,
  ends,
  onEnds,
}: {
  db: string
  schema: string | undefined
  ends: JoinEnds
  onEnds: (ends: JoinEnds) => void
}) {
  const id = useId()
  const dialect = useDialect()
  const tables = useQuery(tablesQuery(db, schema))
  const keys = useQuery(foreignKeysQuery(db, schema))
  const names = (tables.data ?? []).filter((x) => x.kind === 'table').map((x) => x.name)
  if (tables.isSuccess && names.length < 2) return null
  // A name in the URL no table has (dropped, or mistyped) is not chosen.
  const from = ends.from !== undefined && names.includes(ends.from) ? ends.from : undefined
  const to = ends.to !== undefined && ends.to !== from && names.includes(ends.to) ? ends.to : undefined
  const relations = keys.data ? drawnRelations(keys.data, dialect, namespaceOf(db, schema), names) : []
  const found = from && to && keys.data ? joinPaths(relations, from, to) : undefined
  const status =
    from && to
      ? found
        ? found.paths.length > 0
          ? t.found(found.paths.length, found.paths[0]?.length ?? 0, found.more)
          : t.none(from, to)
        : keys.isPending
          ? t.reading
          : ''
      : ''
  return (
    <Card title={t.title}>
      <div className="space-y-3">
        <p className="text-xs text-ink-sub">{t.hint}</p>
        <div className="flex flex-wrap gap-3">
          <Field id={`${id}-from`} label={t.from}>
            <Select
              id={`${id}-from`}
              value={from ?? ''}
              onChange={(e) => {
                const next = e.target.value || undefined
                // One table is not both ends: the other end is let go, here and in the URL.
                onEnds({ from: next, to: to === next ? undefined : to })
              }}
              className="w-56"
            >
              <option value="">{t.choose}</option>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </Select>
          </Field>
          <Field id={`${id}-to`} label={t.to}>
            <Select
              id={`${id}-to`}
              value={to ?? ''}
              onChange={(e) => onEnds({ from, to: e.target.value || undefined })}
              className="w-56"
            >
              <option value="">{t.choose}</option>
              {names
                .filter((n) => n !== from)
                .map((n) => (
                  <option key={n}>{n}</option>
                ))}
            </Select>
          </Field>
        </div>
        {/* One line, there from the start (empty): what was found between the two, heard as they are chosen. */}
        <p role="status" className="text-sm text-ink empty:mb-0">
          {status}
        </p>
        {/* The table list's error is the map's to tell (it reads the same list). */}
        {keys.isError ? <ErrorBox error={keys.error} onRetry={() => void keys.refetch()} /> : null}
        {found && from && to && found.paths.length > 0 ? (
          <Paths db={db} schema={schema} from={from} to={to} paths={found.paths} relations={relations} />
        ) : null}
      </div>
    </Card>
  )
}

function Paths({
  db,
  schema,
  from,
  to,
  paths,
  relations,
}: {
  db: string
  schema: string | undefined
  from: string
  to: string
  paths: readonly JoinHop[][]
  relations: Parameters<typeof diagramFor>[1]
}) {
  const d = diagramFor(
    paths.flatMap((p) => p.flatMap((h) => [h.from, h.to])),
    relations
  )
  return (
    <div className="space-y-3">
      <SchemaDiagram {...d} overlay={walked(from, to, paths)} label={t.diagram(from, to)} />
      <ol className="space-y-3">
        {paths.map((path, i) => {
          const tables = [from, ...path.map((h) => h.to)]
          return (
            <li key={JSON.stringify(tables)} className="space-y-1">
              <p className="text-sm font-medium text-ink">{t.path(i + 1, tables)}</p>
              <ul aria-label={t.steps(i + 1)} className="list-disc pl-5 text-sm text-ink">
                {path.map((h) => (
                  <li key={`${h.from}>${h.to}`}>
                    {t.hop(
                      h.from,
                      h.to,
                      h.keys.map(({ relation: r }) =>
                        t.key(r.table, r.columns.join(', '), r.refTable, r.refColumns.join(', '))
                      )
                    )}
                  </li>
                ))}
              </ul>
              {tables.length <= QUERY_TABLES_LIMIT ? (
                <Link
                  to="/db/$db/query"
                  params={{ db }}
                  search={{ schema, tables }}
                  className="text-sm text-brand underline"
                >
                  {t.build(i + 1)}
                </Link>
              ) : null}
            </li>
          )
        })}
      </ol>
      <p className="text-xs text-ink-sub">{t.buildHint}</p>
    </div>
  )
}

/**
 * The two ends marked, and every key of the paths flowing the way it is walked (against the key where the table
 * walked to is the one that refers). Nothing is drawn faint: every table drawn is on a path.
 */
function walked(from: string, to: string, paths: readonly JoinHop[][]): DiagramOverlay {
  return {
    tables: new Map([from, to].map((x) => [x, { tone: 'focus' as const }])),
    relations: new Map(),
    columns: new Map(),
    fade: false,
    flow: new Map(
      paths.flatMap((p) =>
        p.flatMap((h) =>
          h.keys.map(({ relation, forward }) => [relationKey(relation), forward ? 'forward' : 'back'] as const)
        )
      )
    ),
  }
}
