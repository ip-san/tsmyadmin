import { useQueries, useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { DesignerView, RelationDef } from '@tsmyadmin/shared'
import { DesignerViewSchema } from '@tsmyadmin/shared'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { DisplayColumnSelect } from '@/components/ddl/DisplayColumnSelect.tsx'
import {
  autoLayout,
  boxColumns,
  boxHeight,
  DEFAULT_VIEW,
  drawnRelations,
  makeWidthOf,
  type Point,
  snapAll,
  withAllColumns,
} from '@/components/schema-diagram/layout.ts'
import { SchemaDiagram } from '@/components/schema-diagram/SchemaDiagram.tsx'
import { ErrorBox, Notice, Spinner } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale-screens.ts'
import { useDdlFlow } from '@/lib/ddl.ts'
import { chosenDisplayColumn } from '@/lib/display-column.ts'
import { readPreference, removePreference, writePreference } from '@/lib/preferences.ts'
import { foreignKeysQuery, structureQuery, tablesQuery } from '@/lib/queries.ts'
import { DesignerAddForeignKey } from './DesignerAddForeignKey.tsx'
import { useDesignerFocus } from './DesignerFocus.tsx'
import { DesignerKeys } from './DesignerKeys.tsx'
import { useDesignerOverlays } from './DesignerOverlays.tsx'
import { DesignerPages } from './DesignerPages.tsx'
import { DesignerToolbar } from './DesignerToolbar.tsx'
import { diagramDia } from './designer-dia.ts'
import { diagramEps } from './designer-eps.ts'
import { diagramSvg } from './designer-svg.ts'
import { orphansText } from './reference-overlay.ts'

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
export function Designer({
  db,
  schema,
  compare,
  focus,
  hops = 1,
  onFocus = () => undefined,
}: {
  db: string
  schema?: string | undefined
  /** A snapshot to lay over the diagram: what was added, removed and changed since it was taken. */
  compare?: string | undefined
  /** The table to draw the diagram around, and how many keys out. */
  focus?: string | undefined
  hops?: number
  onFocus?: (focus: string | undefined, hops: number) => void
}) {
  const { session } = useRouteContext({ from: '/_app' })
  const tables = useQuery(tablesQuery(db, schema))
  const keys = useQuery(foreignKeysQuery(db, schema))
  const storageKey = `designer.${session.dialect}.${session.host}.${session.port}.${db}.${schema ?? ''}`
  const [saved, setSaved] = useState<Record<string, Point>>(() => readPreference(storageKey, PositionsSchema, {}))
  const [allColumns, setAllColumns] = useState(false)
  const viewKey = `${storageKey}.view`
  const [view, setView] = useState<DesignerView>(() => readPreference(viewKey, DesignerViewSchema, DEFAULT_VIEW))
  const changeView = (patch: Partial<DesignerView>) => {
    const next = { ...view, ...patch }
    setView(next)
    writePreference(viewKey, next)
    // Turning the grid on lines up the boxes that were placed by hand; the automatic layout is drawn on it.
    if (patch.snap === true && !view.snap) keep(snapAll(saved))
  }
  const [relate, setRelate] = useState(false)
  // Full screen is the browser's: the section fills the screen, and leaving it (Esc) is noticed here.
  const sectionRef = useRef<HTMLElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === sectionRef.current && sectionRef.current !== null)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void sectionRef.current?.requestFullscreen?.()
  }
  const [from, setFrom] = useState<Pick | null>(null)
  const [pair, setPair] = useState<{ from: Pick; to: Pick } | null>(null)
  // Only to redraw the ◆ marks when a display column is chosen (that choice is kept by the browser).
  const [, setDisplayTick] = useState(0)
  const flow = useDdlFlow(db, schema)
  const names = (tables.data ?? []).filter((x) => x.kind === 'table').map((x) => x.name)
  const showAll = allColumns || relate
  // Picking a column needs the columns: a compact box has none.
  const shownView = relate ? { ...view, compact: false } : view
  const structures = useQueries({
    queries: names.map((table) => ({ ...structureQuery({ db, schema, table }), enabled: showAll })),
  })
  const ns = schema ? { database: db, schema } : { database: db }
  const overlays = useDesignerOverlays({
    db,
    schema,
    compare,
    names,
    keys: keys.data,
    ns,
    onMakeKey: (r) =>
      setPair({
        from: { table: r.table, column: r.columns[0] ?? '' },
        to: { table: r.refTable, column: r.refColumns[0] ?? '' },
      }),
  })
  const focused = useDesignerFocus({ focus, hops, names, onChange: onFocus })

  if (tables.isPending || keys.isPending) return <Spinner />
  if (tables.isError) return <ErrorBox error={tables.error} onRetry={() => void tables.refetch()} />
  if (keys.isError) return <ErrorBox error={keys.error} onRetry={() => void keys.refetch()} />
  // Views and sequences hold no foreign keys: they would only be boxes with nothing attached.
  if (names.length === 0) return <Notice>{t.noTables}</Notice>

  const drawn = drawnRelations(keys.data, session.dialect, ns, names)
  const all = new Map(names.map((n, i) => [n, structures[i]?.data?.columns.map((c) => c.name)]))
  // Comparing with a snapshot draws the tables it had that are gone too, with the keys it recorded for them.
  const whole = overlays.shape(names, drawn)
  const shown = focused.apply(whole)
  const columns = new Map(
    shown.tables.map((n) => [n, withAllColumns(boxColumns(n, shown.relations), showAll ? all.get(n) : undefined)])
  )
  const notes = new Map((tables.data ?? []).flatMap((x) => (x.comment ? [[x.name, x.comment] as const] : [])))
  const display = new Map(
    names.flatMap((n) => {
      const chosen = chosenDisplayColumn({ db, schema, table: n })
      return chosen && columns.get(n)?.includes(chosen) ? [[n, chosen] as const] : []
    })
  )
  // A table without a saved position (new, or never moved) takes its place in the automatic layout.
  // The boxes are as wide as their names when asked, which moves the columns of the automatic layout apart.
  const widthOf = makeWidthOf({ tables: shown.tables, columns, display, view: shownView })
  // Boxes that list every column are taller than the key columns they are laid out for otherwise.
  const auto = autoLayout(shown.tables, shown.relations, widthOf, (n) => boxHeight(columns.get(n)?.length ?? 0))
  const positions = focused.positions(shownView.snap ? snapAll(auto) : auto, saved)
  const keep = (next: Record<string, Point>) => {
    setSaved(next)
    // Positions of tables that are gone are dropped, so a table created later under that name starts fresh.
    writePreference(storageKey, Object.fromEntries(Object.entries(next).filter(([name]) => names.includes(name))))
  }
  const move = (table: string, to: Point, commit: boolean) =>
    focused.move(table, to, commit, (name, at, done) => {
      const next = { ...saved, [name]: at }
      if (done) keep(next)
      else setSaved(next)
    })
  // A focused diagram leaves as drawn; otherwise the database's tables (not those of a snapshot compared with).
  const exported = focused.on
    ? {
        tables: shown.tables.filter((n) => names.includes(n)),
        relations: shown.relations.filter((r) => drawn.includes(r)),
      }
    : { tables: names, relations: drawn }
  const pick = (table: string, column: string) => {
    // A table drawn from a snapshot is gone: a key cannot be made to or from it.
    if (!names.includes(table)) return
    if (!from || from.table === table) return setFrom({ table, column })
    setPair({ from, to: { table, column } })
    setFrom(null)
  }
  // Qualified only when the key leaves this namespace: by schema on PostgreSQL (which has no keys across
  // databases), by database on MySQL.
  const target = (r: RelationDef) =>
    drawn.includes(r) ? r.refTable : `${r.refNamespace.schema ?? r.refNamespace.database}.${r.refTable}`

  return (
    <section ref={sectionRef} className="print-expand space-y-3 overflow-auto bg-canvas">
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
        svg={() => diagramSvg({ ...exported, positions, columns, display, view: shownView })}
        dia={() => diagramDia({ ...exported, positions, columns, display, view: shownView })}
        eps={() => diagramEps({ ...exported, positions, columns, display, view: shownView })}
        fileBase={db}
        view={view}
        onView={changeView}
        fullscreen={fullscreen}
        onFullscreen={toggleFullscreen}
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
        {focused.control}
        {overlays.controls}
      </DesignerToolbar>
      {relate && from ? (
        <p role="status" className="text-sm text-ink print:hidden">
          {t.relateFrom(from.table, from.column)}
        </p>
      ) : null}
      {focused.notice(shown.tables.length, whole.tables.length)}
      {overlays.above}
      <SchemaDiagram
        tables={shown.tables}
        relations={shown.relations}
        columns={columns}
        display={display}
        positions={positions}
        onMove={move}
        view={shownView}
        overlay={overlays.overlay(shown.overlay)}
        notes={notes}
        {...(relate ? { relate: { from, onPick: pick } } : {})}
      />
      {overlays.below}
      <DesignerKeys
        keys={keys.data}
        target={target}
        orphans={overlays.refsOn ? (r) => orphansText(overlays.checks, r.table, r.name) ?? '…' : undefined}
        onDrop={(r) => flow.preview({ op: 'dropForeignKey', table: r.table, name: r.name })}
      />
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
          view={view}
          onLoad={(page) => {
            keep(page.positions)
            setAllColumns(page.allColumns)
            if (page.view) {
              setView(page.view)
              writePreference(viewKey, page.view)
            }
          }}
        />
      </div>
      <DdlPreviewDialog flow={flow} />
    </section>
  )
}
