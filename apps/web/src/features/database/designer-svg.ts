import {
  BOX_WIDTH,
  boxHeight,
  DEFAULT_VIEW,
  type DiagramInput,
  fitText,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  relationLabel,
  relationPath,
  relationRoute,
  routeMiddle,
  textRoom,
} from './designer-layout.ts'

const PAD = 40

const xmlText = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/**
 * The diagram as a stand-alone SVG file. Colours are fixed (dark ink on white): the file is opened outside this page,
 * where neither the theme nor the page's stylesheet applies.
 */
export function diagramSvg(o: DiagramInput): string {
  const at = (table: string) => o.positions[table] ?? { x: 0, y: 0 }
  const view = o.view ?? DEFAULT_VIEW
  const columnsOf = (table: string) => (view.compact ? [] : (o.columns.get(table) ?? []))
  const width = Math.max(...o.tables.map((n) => at(n).x + BOX_WIDTH)) + PAD
  const height = Math.max(...o.tables.map((n) => at(n).y + boxHeight(columnsOf(n).length, view.compact))) + PAD
  const lines = view.showLines
    ? o.relations.flatMap((r) => {
        const path = `<path d="${relationPath(r, at, columnsOf, view.lineStyle, view.compact)}" fill="none" stroke="#2563eb" stroke-width="1.5"/>`
        if (!view.lineLabels) return [path]
        const mid = routeMiddle(relationRoute(r, at, columnsOf, view.lineStyle, view.compact))
        return [
          path,
          `<text x="${mid.x}" y="${mid.y - 4}" font-size="10" text-anchor="middle" fill="#2563eb">${xmlText(relationLabel(r))}</text>`,
        ]
      })
    : []
  const boxes = o.tables.map((name) => {
    const p = at(name)
    const cols = columnsOf(name)
    // A name longer than the box is cut with an ellipsis (and named in full in a tooltip): drawn whole it would run
    // across the box's edge.
    const drawn = (full: string, bold: boolean) => {
      const fitted = fitText(full, 12, textRoom(8), bold)
      return fitted === full ? xmlText(full) : `${xmlText(fitted)}<title>${xmlText(full)}</title>`
    }
    const rows = cols.map(
      (c, i) =>
        `<text x="8" y="${HEADER_HEIGHT + i * ROW_HEIGHT + 14}" font-size="12" fill="#52525b">${drawn(
          o.display?.get(name) === c ? `◆ ${c}` : c,
          false
        )}</text>`
    )
    return [
      `<g transform="translate(${p.x} ${p.y})">`,
      `<rect width="${BOX_WIDTH}" height="${boxHeight(cols.length, view.compact)}" rx="4" fill="#ffffff" stroke="#71717a" stroke-width="1.5"/>`,
      `<text x="8" y="18" font-size="12" font-weight="600" fill="#18181b">${drawn(name, true)}</text>`,
      `<line x1="0" x2="${BOX_WIDTH}" y1="${HEADER_HEIGHT}" y2="${HEADER_HEIGHT}" stroke="#d4d4d8"/>`,
      ...rows,
      '</g>',
    ].join('')
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    ...lines,
    ...boxes,
    '</svg>',
  ].join('\n')
}
