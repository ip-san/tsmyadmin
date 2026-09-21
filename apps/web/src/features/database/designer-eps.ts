import {
  boxHeight,
  DEFAULT_VIEW,
  type DiagramInput,
  fitText,
  HEADER_HEIGHT,
  makeWidthOf,
  ROW_HEIGHT,
  relationLabel,
  relationRoute,
  routeMiddle,
  textRoom,
} from './designer-layout.ts'

const PAD = 40

/**
 * A PostScript string: the standard fonts have Latin-1 at best, so anything outside printable ASCII becomes `?`
 * rather than a byte the interpreter would draw as something else. `(`, `)` and `\` are escaped.
 */
const psText = (s: string) =>
  [...s].map((ch) => (ch === '(' || ch === ')' || ch === '\\' ? `\\${ch}` : ch >= ' ' && ch <= '~' ? ch : '?')).join('')

/**
 * The diagram as an Encapsulated PostScript file, black on white. PostScript's origin is the bottom left, so every
 * y is taken from the height. Table and column names are ASCII-only in the file (see `psText`).
 */
export function diagramEps(o: DiagramInput): string {
  const at = (table: string) => o.positions[table] ?? { x: 0, y: 0 }
  const view = o.view ?? DEFAULT_VIEW
  const columnsOf = (table: string) => (view.compact ? [] : (o.columns.get(table) ?? []))
  const widthOf = makeWidthOf(o)
  const width = Math.ceil(Math.max(0, ...o.tables.map((n) => at(n).x + widthOf(n))) + PAD)
  const height = Math.ceil(
    Math.max(0, ...o.tables.map((n) => at(n).y + boxHeight(columnsOf(n).length, view.compact))) + PAD
  )
  const y = (v: number) => Number((height - v).toFixed(2))
  const n = (v: number) => Number(v.toFixed(2))
  const out = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${width} ${height}`,
    '%%Creator: tsmyadmin',
    '%%EndComments',
    '0.75 setlinewidth',
    '/Helvetica findfont 9 scalefont setfont',
  ]
  for (const r of view.showLines ? o.relations : []) {
    const route = relationRoute(r, at, columnsOf, view.lineStyle, view.compact, widthOf)
    if (route.kind === 'curve') {
      out.push(
        `newpath ${n(route.from.x)} ${y(route.from.y)} moveto ${n(route.control1.x)} ${y(route.control1.y)} ${n(route.control2.x)} ${y(route.control2.y)} ${n(route.to.x)} ${y(route.to.y)} curveto stroke`
      )
    } else {
      const [first, ...rest] = route.points
      out.push(
        `newpath ${n(first?.x ?? 0)} ${y(first?.y ?? 0)} moveto ${rest.map((p) => `${n(p.x)} ${y(p.y)} lineto`).join(' ')} stroke`
      )
    }
    if (view.lineLabels) {
      const mid = routeMiddle(route)
      out.push(
        `${n(mid.x)} ${y(mid.y - 4)} moveto (${psText(relationLabel(r))}) dup stringwidth pop 2 div neg 0 rmoveto show`
      )
    }
  }
  for (const name of o.tables) {
    const p = at(name)
    const cols = columnsOf(name)
    const h = boxHeight(cols.length, view.compact)
    const w = widthOf(name)
    // A white fill first, so a line crossing the box does not show through it.
    out.push(
      `gsave 1 setgray newpath ${n(p.x)} ${y(p.y + h)} ${w} ${h} rectfill grestore`,
      `newpath ${n(p.x)} ${y(p.y + h)} ${w} ${h} rectstroke`,
      `newpath ${n(p.x)} ${y(p.y + HEADER_HEIGHT)} moveto ${w} 0 rlineto stroke`,
      `/Helvetica-Bold findfont 9 scalefont setfont ${n(p.x + 6)} ${y(p.y + 14)} moveto (${psText(fitText(name, 9, textRoom(6, w), true))}) show`,
      '/Helvetica findfont 9 scalefont setfont'
    )
    cols.forEach((c, i) => {
      const label = o.display?.get(name) === c ? `* ${c}` : c
      out.push(
        `${n(p.x + 6)} ${y(p.y + HEADER_HEIGHT + i * ROW_HEIGHT + 12)} moveto (${psText(fitText(label, 9, textRoom(6, w)))}) show`
      )
    })
  }
  out.push('showpage', '%%EOF')
  return `${out.join('\n')}\n`
}
