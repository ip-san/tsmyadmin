import type { DesignerView, RelationDef } from '@tsmyadmin/shared'
import { useId, useState } from 'react'
import { locale } from '@/config/locale-screens.ts'
import { Badge, LineBadge } from './Badge.tsx'
import {
  boxHeight,
  DEFAULT_VIEW,
  fitText,
  GRID,
  HEADER_HEIGHT,
  makeWidthOf,
  type Point,
  ROW_HEIGHT,
  relationKey,
  relationLabel,
  relationPath,
  relationRoute,
  routeMiddle,
  textRoom,
} from './layout.ts'
import { type DiagramOverlay, FADE, FAINT, TONE_STROKE } from './overlay.ts'
import { useBoxDrag } from './use-box-drag.ts'

const t = locale.designer
const PAD = 40

const NO_DISPLAY: ReadonlyMap<string, string> = new Map()
/** Room under a box for its note: one line of small text, inside the gap between stacked boxes. */
const NOTE_ROOM = 18
const withNote = (label: string, note: string | undefined) => (note ? t.withNote(label, note) : label)

/**
 * Tables as boxes and foreign keys as lines. Boxes move by dragging or, once focused, with the arrow keys (Shift
 * for larger steps); `commit` is true for the move that ends one, which is when the page saves the layout.
 * Without `onMove` (or `relate`) the diagram is a picture only: a story told on it (`overlay`) is read out by the
 * steps listed beside it, so the picture is one image to a screen reader rather than a field of buttons.
 */
export function SchemaDiagram({
  tables,
  relations,
  columns,
  display = NO_DISPLAY,
  positions,
  onMove,
  relate,
  view = DEFAULT_VIEW,
  overlay,
  notes = NO_DISPLAY,
  label = t.diagram,
}: {
  tables: readonly string[]
  relations: readonly RelationDef[]
  /** What each box lists. */
  columns: ReadonlyMap<string, readonly string[]>
  /** The column marked as each table's display column. */
  display?: ReadonlyMap<string, string>
  positions: Readonly<Record<string, Point>>
  onMove?: (table: string, to: Point, commit: boolean) => void
  /** While set, the columns are the buttons (pick one, then the one it refers to) and boxes stay where they are. */
  relate?: { from: { table: string; column: string } | null; onPick: (table: string, column: string) => void }
  view?: DesignerView
  /** Tables, keys and columns lit up; the rest is drawn faint. */
  overlay?: DiagramOverlay | undefined
  /** A line of text under a box (the table's comment), drawn when `view.comments` is on. */
  notes?: ReadonlyMap<string, string>
  /** What the diagram is, for a screen reader. */
  label?: string
}) {
  /** The box last focused or picked: its names are shown whole below the diagram (the boxes cut what does not fit). */
  const [selected, setSelected] = useState<string | null>(null)
  const at = (table: string): Point => positions[table] ?? { x: 0, y: 0 }
  const listed = (table: string) => (view.compact ? [] : (columns.get(table) ?? []))
  const fullLabel = (table: string, c: string) => (display.get(table) === c ? `◆ ${c}` : c)
  const widthOf = makeWidthOf({ tables, columns, display, view })
  const room = (name: string) => textRoom(8, widthOf(name))
  const cutAny = tables.some(
    (name) =>
      fitText(name, 12, room(name), true) !== name ||
      listed(name).some((c) => fitText(fullLabel(name, c), 12, room(name)) !== fullLabel(name, c))
  )
  const gridId = `grid${useId().replace(/\W/g, '')}`
  const width = Math.max(...tables.map((name) => at(name).x + widthOf(name))) + PAD
  // Under the box, in the gap the layout leaves between boxes: it moves no line's end.
  const noteOf = (table: string) => (view.comments ? notes.get(table) : undefined)
  const height =
    Math.max(
      ...tables.map(
        (name) => at(name).y + boxHeight(listed(name).length, view.compact) + (noteOf(name) ? NOTE_ROOM : 0)
      )
    ) + PAD
  const { startDrag, moveDrag, endDrag, nudge } = useBoxDrag({ at, snap: view.snap, onMove, onGrab: setSelected })

  const shown = selected !== null && tables.includes(selected) ? selected : null
  const pictureOnly = !onMove && !relate
  const faint = (lit: boolean) => (overlay && overlay.fade !== false && !lit ? `${FADE} ${FAINT}` : FADE)
  return (
    <>
      <figure
        // A picture has nothing to focus inside: the frame itself takes the keyboard, so a wide one can be scrolled.
        tabIndex={pictureOnly ? 0 : undefined}
        className="max-h-[70vh] overflow-auto rounded border border-line bg-surface-sub"
      >
        <figcaption className="sr-only">{label}</figcaption>
        <svg
          width={width}
          height={height}
          className="select-none"
          {...(pictureOnly ? { role: 'img', 'aria-label': label } : {})}
        >
          {view.snap ? (
            <>
              <defs>
                <pattern id={gridId} width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                  <circle cx={1} cy={1} r={1} className="fill-line-strong" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill={`url(#${gridId})`} aria-hidden data-testid="designer-grid" />
            </>
          ) : null}
          {(view.showLines ? relations : []).map((r) => {
            const badge = overlay?.relationBadges?.get(relationKey(r))
            const middle =
              view.lineLabels || badge
                ? routeMiddle(relationRoute(r, at, listed, view.lineStyle, view.compact, widthOf))
                : null
            const mid = view.lineLabels ? middle : null
            const tone = overlay?.relations.get(relationKey(r))
            const stroke = tone ? TONE_STROKE[tone] : undefined
            return (
              <g key={relationKey(r)} aria-hidden className={faint(tone !== undefined)} data-tone={tone}>
                <path
                  d={relationPath(r, at, listed, view.lineStyle, view.compact, widthOf)}
                  className={`fill-none ${stroke?.className ?? 'stroke-brand'}`}
                  strokeWidth={stroke?.width ?? 1.5}
                  strokeDasharray={stroke?.dash}
                />
                {mid ? (
                  <text x={mid.x} y={mid.y - 4} textAnchor="middle" className="fill-brand text-[10px]">
                    {relationLabel(r)}
                  </text>
                ) : null}
                {badge && middle ? <LineBadge text={badge} at={middle} /> : null}
              </g>
            )
          })}
          {tables.map((name) => {
            const p = at(name)
            const cols = listed(name)
            const lit = overlay?.tables.get(name)
            const stroke = lit ? TONE_STROKE[lit.tone] : undefined
            const contents = (
              <>
                <rect
                  width={widthOf(name)}
                  height={boxHeight(cols.length, view.compact)}
                  rx={4}
                  className={`fill-surface ${stroke?.className ?? 'stroke-line-strong'} group-focus-visible:stroke-brand`}
                  strokeWidth={stroke?.width ?? 1.5}
                  strokeDasharray={stroke?.dash}
                />
                <text x={8} y={18} className="fill-ink text-xs font-semibold">
                  {fitText(name, 12, room(name), true)}
                  {/* The whole name, when it was cut: shown as a tooltip. */}
                  {fitText(name, 12, room(name), true) === name ? null : <title>{name}</title>}
                </text>
                <line x1={0} x2={widthOf(name)} y1={HEADER_HEIGHT} y2={HEADER_HEIGHT} className="stroke-line" />
                {lit?.badge ? <Badge text={lit.badge} right={widthOf(name)} /> : null}
                {noteOf(name) ? (
                  <text x={4} y={boxHeight(cols.length, view.compact) + 14} className="fill-ink-sub text-[11px] italic">
                    {fitText(noteOf(name) ?? '', 11, widthOf(name) - 8)}
                    <title>{noteOf(name)}</title>
                  </text>
                ) : null}
              </>
            )
            const marked = (c: string) => overlay?.columns.get(name)?.has(c) === true
            const columnText = (c: string) => (display.get(name) === c ? `◆ ${c}` : c)
            if (relate) {
              return (
                <g
                  key={name}
                  transform={`translate(${p.x} ${p.y})`}
                  className={faint(lit !== undefined)}
                  data-tone={lit?.tone}
                >
                  {contents}
                  {cols.map((c, i) => {
                    const picked = relate.from?.table === name && relate.from.column === c
                    const y = HEADER_HEIGHT + i * ROW_HEIGHT
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>.
                      <g
                        key={c}
                        role="button"
                        tabIndex={0}
                        aria-label={t.columnLabel(name, c)}
                        aria-pressed={picked}
                        className="group cursor-pointer outline-none"
                        onFocus={() => setSelected(name)}
                        onClick={() => relate.onPick(name, c)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          relate.onPick(name, c)
                        }}
                      >
                        <rect
                          x={1}
                          y={y}
                          width={widthOf(name) - 2}
                          height={ROW_HEIGHT}
                          className={`${picked ? 'fill-row-hover stroke-brand' : 'fill-transparent'} group-hover:fill-row-hover group-focus-visible:stroke-brand`}
                        />
                        <text x={8} y={y + 14} className="fill-ink-sub text-xs">
                          {fitText(columnText(c), 12, room(name))}
                          {fitText(columnText(c), 12, room(name)) === columnText(c) ? null : (
                            <title>{columnText(c)}</title>
                          )}
                        </text>
                      </g>
                    )
                  })}
                </g>
              )
            }
            const rows = cols.map((c, i) => (
              <g key={c}>
                {marked(c) ? (
                  <rect
                    x={1}
                    y={HEADER_HEIGHT + i * ROW_HEIGHT}
                    width={widthOf(name) - 2}
                    height={ROW_HEIGHT}
                    className="fill-row-hover"
                  />
                ) : null}
                <text
                  x={8}
                  y={HEADER_HEIGHT + i * ROW_HEIGHT + 14}
                  className={`text-xs ${marked(c) ? 'fill-ink font-semibold' : 'fill-ink-sub'}`}
                >
                  {fitText(columnText(c), 12, room(name))}
                  {fitText(columnText(c), 12, room(name)) === columnText(c) ? null : <title>{columnText(c)}</title>}
                </text>
              </g>
            ))
            if (pictureOnly) {
              return (
                <g
                  key={name}
                  transform={`translate(${p.x} ${p.y})`}
                  className={faint(lit !== undefined)}
                  data-tone={lit?.tone}
                >
                  {contents}
                  {rows}
                </g>
              )
            }
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>.
              <g
                key={name}
                role="button"
                tabIndex={0}
                aria-label={withNote(
                  lit?.badge ? t.boxLabelWithBadge(name, lit.badge) : t.boxLabel(name),
                  noteOf(name)
                )}
                transform={`translate(${p.x} ${p.y})`}
                // touch-none: on a touch screen the gesture moves the box instead of scrolling the diagram.
                className={`group cursor-move touch-none outline-none ${faint(lit !== undefined)}`}
                data-tone={lit?.tone}
                onFocus={() => setSelected(name)}
                onPointerDown={startDrag(name)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={nudge(name)}
              >
                {contents}
                {rows}
              </g>
            )
          })}
        </svg>
      </figure>
      {pictureOnly ? null : shown !== null ? (
        // Where a name the box had to cut is read whole (and copied): a tooltip is out of reach on a touch screen and
        // from the keyboard.
        <output aria-live="polite" className="mt-2 block rounded border border-line bg-surface p-2 text-sm">
          <span className="sr-only">{t.selectedBox}: </span>
          <span className="select-text break-all font-semibold text-ink">{shown}</span>
          {listed(shown).length > 0 ? (
            <ul className="mt-1 select-text space-y-0.5 break-all font-mono text-xs text-ink-sub">
              {listed(shown).map((c) => (
                <li key={c}>{fullLabel(shown, c)}</li>
              ))}
            </ul>
          ) : null}
        </output>
      ) : cutAny ? (
        <p className="mt-2 text-xs text-ink-sub">{t.cutHint}</p>
      ) : null}
    </>
  )
}
