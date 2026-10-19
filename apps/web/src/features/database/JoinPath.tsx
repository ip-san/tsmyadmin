import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { drawnRelations } from '@/components/schema-diagram/layout.ts'
import { diagramFor } from '@/components/schema-diagram/overlay.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox } from '@/components/ui/Feedback.tsx'
import { Field, Select } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale-screens.ts'
import { namespaceOf } from '@/lib/home-namespace.ts'
import { foreignKeysQuery, tablesQuery } from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { type JoinHop, joinPaths } from './join-path.ts'

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
  const error = tables.isError ? tables : keys.isError ? keys : undefined
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
              onChange={(e) => onEnds({ from: e.target.value || undefined, to })}
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
        {error ? <ErrorBox error={error.error} onRetry={() => void error.refetch()} /> : null}
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
      <SchemaDiagram {...d} label={t.diagram(from, to)} />
      <ol className="space-y-3">
        {paths.map((path, i) => {
          const tables = [from, ...path.map((h) => h.to)]
          return (
            <li key={tables.join('>')} className="space-y-1">
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
              <Link
                to="/db/$db/query"
                params={{ db }}
                search={{ schema, tables }}
                className="text-sm text-brand underline"
              >
                {t.build(i + 1)}
              </Link>
            </li>
          )
        })}
      </ol>
      <p className="text-xs text-ink-sub">{t.buildHint}</p>
    </div>
  )
}
