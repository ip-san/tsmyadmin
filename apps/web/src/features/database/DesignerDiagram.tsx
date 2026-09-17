import type { RelationDef } from '@tsmyadmin/shared'
import { type KeyboardEvent, type PointerEvent, useRef } from 'react'
import { locale } from '@/config/locale.ts'
import { anchor, BOX_WIDTH, boxColumns, boxHeight, HEADER_HEIGHT, type Point, ROW_HEIGHT } from './designer-layout.ts'

const t = locale.designer
const STEP = 10
const BIG_STEP = 50
const PAD = 40

/** Distinct per key: constraint names are unique within a table, not across the database. */
export const relationKey = (r: RelationDef) => JSON.stringify([r.table, r.name])

/**
 * Tables as boxes and foreign keys as lines. Boxes move by dragging or, once focused, with the arrow keys (Shift
 * for larger steps); `onMoved` fires once a move ends, which is when the page saves the layout.
 */
export function DesignerDiagram({
  tables,
  relations,
  positions,
  onMove,
  onMoved,
}: {
  tables: readonly string[]
  relations: readonly RelationDef[]
  positions: Readonly<Record<string, Point>>
  onMove: (table: string, to: Point) => void
  onMoved: () => void
}) {
  const drag = useRef<{ table: string; dx: number; dy: number } | null>(null)
  const columns = new Map(tables.map((name) => [name, boxColumns(name, relations)]))
  const at = (table: string): Point => positions[table] ?? { x: 0, y: 0 }
  const width = Math.max(...tables.map((name) => at(name).x + BOX_WIDTH)) + PAD
  const height = Math.max(...tables.map((name) => at(name).y + boxHeight(columns.get(name)?.length ?? 0))) + PAD
  const clamp = (p: Point): Point => ({ x: Math.max(0, p.x), y: Math.max(0, p.y) })

  const startDrag = (table: string) => (e: PointerEvent<SVGGElement>) => {
    const p = at(table)
    drag.current = { table, dx: e.clientX - p.x, dy: e.clientY - p.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveDrag = (e: PointerEvent<SVGGElement>) => {
    const d = drag.current
    if (d) onMove(d.table, clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }))
  }
  const endDrag = () => {
    if (!drag.current) return
    drag.current = null
    onMoved()
  }
  const nudge = (table: string) => (e: KeyboardEvent<SVGGElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP
    const delta: Partial<Record<string, Point>> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    const p = at(table)
    onMove(table, clamp({ x: p.x + d.x, y: p.y + d.y }))
    onMoved()
  }

  return (
    <figure className="max-h-[70vh] overflow-auto rounded border border-line bg-surface-sub">
      <figcaption className="sr-only">{t.diagram}</figcaption>
      <svg width={width} height={height} className="select-none">
        {relations.map((r) => {
          const from = at(r.table)
          const to = at(r.refTable)
          const a = anchor(from, columns.get(r.table) ?? [], r.columns[0] ?? '', to.x + BOX_WIDTH / 2)
          const b = anchor(to, columns.get(r.refTable) ?? [], r.refColumns[0] ?? '', from.x + BOX_WIDTH / 2)
          const bend = Math.max(40, Math.abs(b.x - a.x) / 2)
          const ax = a.x === from.x ? a.x - bend : a.x + bend
          const bx = b.x === to.x ? b.x - bend : b.x + bend
          return (
            <path
              key={relationKey(r)}
              d={`M ${a.x} ${a.y} C ${ax} ${a.y}, ${bx} ${b.y}, ${b.x} ${b.y}`}
              className="fill-none stroke-brand"
              strokeWidth={1.5}
              aria-hidden
            />
          )
        })}
        {tables.map((name) => {
          const p = at(name)
          const cols = columns.get(name) ?? []
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>.
            <g
              key={name}
              role="button"
              tabIndex={0}
              aria-label={t.boxLabel(name)}
              transform={`translate(${p.x} ${p.y})`}
              className="group cursor-move outline-none"
              onPointerDown={startDrag(name)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={nudge(name)}
            >
              <rect
                width={BOX_WIDTH}
                height={boxHeight(cols.length)}
                rx={4}
                className="fill-surface stroke-line-strong group-focus-visible:stroke-brand"
                strokeWidth={1.5}
              />
              <text x={8} y={18} className="fill-ink text-xs font-semibold">
                {name}
              </text>
              <line x1={0} x2={BOX_WIDTH} y1={HEADER_HEIGHT} y2={HEADER_HEIGHT} className="stroke-line" />
              {cols.map((c, i) => (
                <text key={c} x={8} y={HEADER_HEIGHT + i * ROW_HEIGHT + 14} className="fill-ink-sub text-xs">
                  {c}
                </text>
              ))}
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
