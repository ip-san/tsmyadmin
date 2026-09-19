import { useQueries, useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { RelationDef } from '@tsmyadmin/shared'
import { useState } from 'react'
import { z } from 'zod'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { DisplayColumnSelect } from '@/components/ddl/DisplayColumnSelect.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { chosenDisplayColumn } from '@/lib/display-column.ts'
import { readPreference, removePreference, writePreference } from '@/lib/preferences.ts'
import { foreignKeysQuery, structureQuery, tablesQuery } from '@/lib/queries.ts'
import { DesignerAddForeignKey } from './DesignerAddForeignKey.tsx'
import { DesignerDiagram, relationKey } from './DesignerDiagram.tsx'
import { DesignerPages } from './DesignerPages.tsx'
import { DesignerToolbar } from './DesignerToolbar.tsx'
import { autoLayout, boxColumns, drawnRelations, type Point, withAllColumns } from './designer-layout.ts'
import { diagramSvg } from './designer-svg.ts'

const t = locale.designer
const PositionsSchema = z.record(z.string(), z.object({ x: z.number(), y: z.number() }))

/** The two columns picked on the diagram: the one that will hold the key, then the one it refers to. */
interface Pick {
  table: string
  column: string
}

/**
 * phpMyAdmin's Designer: the database's tables and the foreign keys between them. Boxes move by dragging; the
 * layout is kept in this browser, or under a name (a "page"). Keys are made by picking one column and then the
 * one it refers to, and dropped from the table under the diagram, which lists the same keys for anyone not using
 * the picture. The diagram leaves as an SVG file or, through the browser's print dialog, as a PDF.
 */
export function Designer({ db, schema }: { db: string; schema?: string | undefined }) {
  const { session } = useRouteContext({ from: '/_app' })
  const tables = useQuery(tablesQuery(db, schema))
  const keys = useQuery(foreignKeysQuery(db, schema))
  const storageKey = `designer.${session.dialect}.${session.host}.${session.port}.${db}.${schema ?? ''}`
  const [saved, setSaved] = useState<Record<string, Point>>(() => readPreference(storageKey, PositionsSchema, {}))
  const [allColumns, setAllColumns] = useState(false)
  const [relate, setRelate] = useState(false)
  const [from, setFrom] = useState<Pick | null>(null)
  const [pair, setPair] = useState<{ from: Pick; to: Pick } | null>(null)
  // Only to redraw the ◆ marks when a display column is chosen (that choice is kept by the browser).
  const [, setDisplayTick] = useState(0)
  const flow = useDdlFlow(db, schema)
  const names = (tables.data ?? []).filter((x) => x.kind === 'table').map((x) => x.name)
  const showAll = allColumns || relate
  const structures = useQueries({
    queries: names.map((table) => ({ ...structureQuery({ db, schema, table }), enabled: showAll })),
  })

  if (tables.isPending || keys.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  if (keys.isError) return <ErrorBox error={keys.error} onRetry={() => void keys.refetch()} />
  // Views and sequences hold no foreign keys: they would only be boxes with nothing attached.
  if (names.length === 0) return <Notice>{t.noTables}</Notice>

  const drawn = drawnRelations(keys.data, session.dialect, schema ? { database: db, schema } : { database: db }, names)
  const all = new Map(names.map((n, i) => [n, structures[i]?.data?.columns.map((c) => c.name)]))
  const columns = new Map(names.map((n) => [n, withAllColumns(boxColumns(n, drawn), showAll ? all.get(n) : undefined)]))
  const display = new Map(
    names.flatMap((n) => {
      const chosen = chosenDisplayColumn({ db, schema, table: n })
      return chosen && columns.get(n)?.includes(chosen) ? [[n, chosen] as const] : []
    })
  )
  // A table without a saved position (new, or never moved) takes its place in the automatic layout.
  const positions = { ...autoLayout(names, drawn), ...saved }
  const keep = (next: Record<string, Point>) => {
    setSaved(next)
    // Positions of tables that are gone are dropped, so a table created later under that name starts fresh.
    writePreference(storageKey, Object.fromEntries(Object.entries(next).filter(([name]) => names.includes(name))))
  }
  const move = (table: string, to: Point, commit: boolean) => {
    const next = { ...saved, [table]: to }
    if (commit) keep(next)
    else setSaved(next)
  }
  const pick = (table: string, column: string) => {
    if (!from || from.table === table) return setFrom({ table, column })
    setPair({ from, to: { table, column } })
    setFrom(null)
  }
  // Qualified only when the key leaves this namespace: by schema on PostgreSQL (which has no keys across
  // databases), by database on MySQL.
  const target = (r: RelationDef) =>
    drawn.includes(r) ? r.refTable : `${r.refNamespace.schema ?? r.refNamespace.database}.${r.refTable}`

  return (
    <section className="print-expand space-y-3">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <h2 className="text-sm font-semibold text-ink">{t.title}</h2>
        <p className="text-xs text-ink-sub">{relate ? t.relateHint : t.hint}</p>
      </div>
      <DesignerToolbar
        allColumns={allColumns}
        onAllColumns={setAllColumns}
        relate={relate}
        onRelate={(on) => {
          setRelate(on)
          setFrom(null)
        }}
        canReset={Object.keys(saved).length > 0}
        onReset={() => {
          removePreference(storageKey)
          setSaved({})
        }}
        svg={() => diagramSvg({ tables: names, relations: drawn, positions, columns, display })}
        fileBase={db}
      >
        <DesignerAddForeignKey
          db={db}
          schema={schema}
          tables={names}
          preset={
            pair
              ? { table: pair.from.table, column: pair.from.column, refTable: pair.to.table, refColumn: pair.to.column }
              : undefined
          }
          onPresetDone={() => setPair(null)}
        />
      </DesignerToolbar>
      {relate && from ? (
        <p role="status" className="text-sm text-ink print:hidden">
          {t.relateFrom(from.table, from.column)}
        </p>
      ) : null}
      <DesignerDiagram
        tables={names}
        relations={drawn}
        columns={columns}
        display={display}
        positions={positions}
        onMove={move}
        {...(relate ? { relate: { from, onPick: pick } } : {})}
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
              <Th className="print:hidden">{locale.ddl.actions}</Th>
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
                <Td className="print:hidden">
                  <Button
                    size="sm"
                    variant="danger"
                    aria-haspopup="dialog"
                    aria-label={t.dropKey(r.table, r.name)}
                    onClick={() => flow.preview({ op: 'dropForeignKey', table: r.table, name: r.name })}
                  >
                    {t.drop}
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="space-y-2 print:hidden">
        <h3 className="text-sm font-semibold text-ink">{t.displayColumns}</h3>
        <p className="text-xs text-ink-sub">{showAll ? t.displayColumnsHint : t.displayColumnsNeedColumns}</p>
        {showAll ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {names.map((n) => (
              <li key={n} className="flex items-center gap-1 text-xs text-ink">
                <span className="font-medium">{n}</span>
                <DisplayColumnSelect
                  tableRef={{ db, schema, table: n }}
                  columns={all.get(n) ?? []}
                  onChange={() => setDisplayTick((x) => x + 1)}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="print:hidden">
        <DesignerPages
          db={db}
          schema={schema}
          positions={positions}
          allColumns={allColumns}
          onLoad={(page) => {
            keep(page.positions)
            setAllColumns(page.allColumns)
          }}
        />
      </div>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
