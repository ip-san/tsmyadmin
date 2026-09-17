import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { RelationDef } from '@tsmyadmin/shared'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { readPreference, removePreference, writePreference } from '@/lib/preferences.ts'
import { foreignKeysQuery, tablesQuery } from '@/lib/queries.ts'
import { DesignerDiagram, relationKey } from './DesignerDiagram.tsx'
import { autoLayout, drawnRelations, type Point } from './designer-layout.ts'

const t = locale.designer
const PositionsSchema = z.record(z.string(), z.object({ x: z.number(), y: z.number() }))

/**
 * phpMyAdmin's Designer, read-only: the database's tables and the foreign keys between them. Box positions are
 * kept in this browser only. The table under the diagram lists the same keys for anyone not using the picture.
 */
export function Designer({ db, schema }: { db: string; schema?: string | undefined }) {
  const { session } = useRouteContext({ from: '/_app' })
  const tables = useQuery(tablesQuery(db, schema))
  const keys = useQuery(foreignKeysQuery(db, schema))
  const storageKey = `designer.${session.dialect}.${session.host}.${session.port}.${db}.${schema ?? ''}`
  const [saved, setSaved] = useState<Record<string, Point>>(() => readPreference(storageKey, PositionsSchema, {}))

  if (tables.isPending || keys.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  if (keys.isError) return <ErrorBox error={keys.error} onRetry={() => void keys.refetch()} />
  // Views and sequences hold no foreign keys: they would only be boxes with nothing attached.
  const names = tables.data.filter((x) => x.kind === 'table').map((x) => x.name)
  if (names.length === 0) return <Notice>{t.noTables}</Notice>

  const drawn = drawnRelations(keys.data, session.dialect, schema ? { database: db, schema } : { database: db }, names)
  // A table without a saved position (new, or never moved) takes its place in the automatic layout.
  const positions = { ...autoLayout(names, drawn), ...saved }
  const target = (r: RelationDef) =>
    drawn.includes(r)
      ? r.refTable
      : [r.refNamespace.database, r.refNamespace.schema, r.refTable].filter((part) => part !== undefined).join('.')

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-ink">{t.title}</h2>
        <p className="text-xs text-ink-sub">{t.hint}</p>
        <Button
          size="sm"
          className="ml-auto"
          disabled={Object.keys(saved).length === 0}
          onClick={() => {
            removePreference(storageKey)
            setSaved({})
          }}
        >
          {t.resetLayout}
        </Button>
      </div>
      <DesignerDiagram
        tables={names}
        relations={drawn}
        positions={positions}
        onMove={(table, to) => setSaved((prev) => ({ ...prev, [table]: to }))}
        onMoved={() =>
          setSaved((prev) => {
            writePreference(storageKey, prev)
            return prev
          })
        }
      />
      <h3 className="text-sm font-semibold text-ink">{t.relations}</h3>
      {keys.data.length === 0 ? (
        <p className="text-sm text-ink-sub">{t.noRelations}</p>
      ) : (
        <Table aria-label={t.relations}>
          <thead>
            <tr>
              <Th>{t.table}</Th>
              <Th>{t.columns}</Th>
              <Th>{t.references}</Th>
              <Th>{t.refColumns}</Th>
              <Th>ON DELETE</Th>
              <Th>ON UPDATE</Th>
              <Th>{t.constraint}</Th>
            </tr>
          </thead>
          <tbody>
            {keys.data.map((r) => (
              <Tr key={relationKey(r)}>
                <Td>{r.table}</Td>
                <Td>{r.columns.join(', ')}</Td>
                <Td>{target(r)}</Td>
                <Td>{r.refColumns.join(', ')}</Td>
                <Td>{r.onDelete ?? '—'}</Td>
                <Td>{r.onUpdate ?? '—'}</Td>
                <Td className="text-ink-sub">{r.name}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
