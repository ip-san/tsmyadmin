import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TableSchema } from '@tsmyadmin/shared'
import { useState } from 'react'
import { drawnRelations } from '@/components/schema-diagram/layout.ts'
import { neighbourhood } from '@/components/schema-diagram/neighbourhood.ts'
import { diagramFor } from '@/components/schema-diagram/overlay.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Card } from '@/components/ui/Card.tsx'
import { ErrorBox, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale-screens.ts'
import { cellToText } from '@/lib/format.ts'
import { homeNamespace, namespaceOf } from '@/lib/home-namespace.ts'
import {
  foreignKeysQuery,
  rowsQuery,
  structureQuery,
  type TableRef,
  tableStatsQuery,
  tableUsageQuery,
} from '@/lib/queries.ts'
import { useDialect } from '@/lib/session.ts'
import { tableRole } from '@/lib/table-role.ts'
import { OverviewColumns } from './OverviewColumns.tsx'
import { UsedByCard } from './UsedByCard.tsx'

const t = locale.overview
/** Rows shown as a sample: enough to see what a row looks like. */
const SAMPLE_ROWS = 5

/**
 * What a table is, on one page: its role (guessed from its keys), size and comment, what its columns hold, a few
 * of its rows, the tables a key away, and how it is read. Every part is read on its own, so a slow one (the
 * profile, which reads rows) does not hold the others back.
 */
export function TableOverview({ tableRef }: { tableRef: TableRef }) {
  const structure = useQuery(structureQuery(tableRef))
  const dialect = useDialect()
  // A view's rows are worked out when read, and a view may be heavy: its rows are read (counted, shown) once asked.
  const [asked, setAsked] = useState(false)
  if (structure.isPending) return <Spinner />
  if (structure.isError) return <ErrorBox error={structure.error} onRetry={() => void structure.refetch()} />
  const schema = structure.data
  const guess = tableRole(schema, homeNamespace(dialect, namespaceOf(tableRef.db, tableRef.schema)))
  const read = schema.kind === 'table' || asked
  return (
    <div className="space-y-4">
      <Card title={t.whatTitle}>
        {schema.kind === 'table' ? (
          <>
            <p className="text-sm text-ink">{t.roles[guess.role]}</p>
            <p className="text-xs text-ink-sub">{t.roleWhy(guess.refersTo, guess.referredBy)}</p>
            {guess.self && guess.role !== 'tree' ? <p className="text-xs text-ink-sub">{t.selfToo}</p> : null}
          </>
        ) : (
          // A view has no keys of its own to guess from: what it reads is on the dependency card below.
          <p className="text-sm text-ink">{schema.kind === 'sequence' ? t.isSequence : t.isView}</p>
        )}
        {schema.comment ? <p className="mt-1 text-sm text-ink">{schema.comment}</p> : null}
        <SizeLine tableRef={tableRef} />
        <UsageLine tableRef={tableRef} />
      </Card>
      {/* A sequence is one value, not rows: nothing to count or show. */}
      {schema.kind === 'sequence' ? null : (
        <>
          {read ? null : (
            <Card>
              <p className="text-xs text-ink-sub">{t.viewHint}</p>
              <Button size="sm" onClick={() => setAsked(true)}>
                {t.countNow}
              </Button>
            </Card>
          )}
          {read ? (
            <>
              <Card title={t.columns}>
                <OverviewColumns tableRef={tableRef} columns={schema.columns} read={read} />
              </Card>
              <Card title={t.sample} bleed>
                <SampleRows tableRef={tableRef} schema={schema} />
              </Card>
            </>
          ) : null}
        </>
      )}
      <Card title={t.neighbours}>
        <Neighbours tableRef={tableRef} />
      </Card>
      {schema.kind === 'sequence' ? null : <UsedByCard tableRef={tableRef} view={schema.kind !== 'table'} />}
    </div>
  )
}

function SizeLine({ tableRef }: { tableRef: TableRef }) {
  const stats = useQuery(tableStatsQuery(tableRef))
  if (!stats.data) return null
  const s = stats.data
  return (
    <p className="mt-1 text-xs text-ink-sub">
      {t.size(s.rowEstimate, s.totalBytes === null ? null : locale.common.bytes(s.totalBytes), s.updatedAt)}
    </p>
  )
}

function UsageLine({ tableRef }: { tableRef: TableRef }) {
  const usage = useQuery(tableUsageQuery(tableRef.db, tableRef.schema))
  const own = usage.data?.status === 'ok' ? usage.data.tables.find((u) => u.table === tableRef.table) : undefined
  if (!usage.data || usage.data.status !== 'ok') return null
  return (
    <p className="text-xs text-ink-sub">
      {own ? t.usage(own.fullReads, own.indexReads, usage.data.unit) : t.usageNone}
    </p>
  )
}

function SampleRows({ tableRef, schema }: { tableRef: TableRef; schema: TableSchema }) {
  const rows = useQuery(rowsQuery(tableRef, { offset: 0, limit: SAMPLE_ROWS, sort: [], filters: [] }))
  if (rows.isPending) return <Spinner />
  if (rows.isError) return <ErrorBox error={rows.error} onRetry={() => void rows.refetch()} />
  const names = schema.columns.map((c) => c.name)
  if (rows.data.rows.length === 0) return <p className="p-4 text-sm text-ink-sub">{t.noRows}</p>
  return (
    <div className="overflow-x-auto">
      <Table aria-label={t.sample}>
        <thead>
          <tr>
            {names.map((n) => (
              <Th key={n}>{n}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.data.rows.map((row, i) => (
            // A sample of rows read once, not edited or reordered: its place names a row.
            <Tr key={i}>
              {names.map((n, j) => (
                // Cut to the column's width; the whole value as a tooltip.
                <Td key={n} className="max-w-48 truncate font-mono text-xs" title={cellToText(row[j] ?? null)}>
                  {cellToText(row[j] ?? null)}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}

/** The tables one key away, drawn as a picture (the Designer draws more, from the link). */
function Neighbours({ tableRef }: { tableRef: TableRef }) {
  const { db, schema, table } = tableRef
  const dialect = useDialect()
  const keys = useQuery(foreignKeysQuery(db, schema))
  if (keys.isPending) return <Spinner />
  if (keys.isError) return <ErrorBox error={keys.error} onRetry={() => void keys.refetch()} />
  const ns = namespaceOf(db, schema)
  const names = [...new Set(keys.data.flatMap((k) => [k.table, k.refTable]).concat(table))]
  const relations = drawnRelations(keys.data, dialect, ns, names)
  const near = neighbourhood(names, relations, table, 1)
  const link = (
    <Link
      to="/db/$db/designer"
      params={{ db }}
      search={{ schema, focus: table, hops: 1 }}
      className="text-sm text-brand underline"
    >
      {t.openDesigner}
    </Link>
  )
  if (near.size <= 1)
    return (
      <div className="space-y-1">
        <p className="text-sm text-ink-sub">{t.noNeighbours}</p>
        {link}
      </div>
    )
  const d = diagramFor(near, relations)
  return (
    <div className="space-y-2">
      <SchemaDiagram {...d} label={t.neighboursDiagram(table)} />
      <ul aria-label={t.neighboursList} className="list-disc pl-5 text-sm text-ink">
        {d.relations.map((r) => (
          <li key={`${r.table}.${r.name}`}>{t.keySentence(r.table, r.columns.join(', '), r.refTable)}</li>
        ))}
      </ul>
      {link}
    </div>
  )
}
