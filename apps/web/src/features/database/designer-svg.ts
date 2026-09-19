import type { RelationDef } from '@tsmyadmin/shared'
import { BOX_WIDTH, boxHeight, HEADER_HEIGHT, type Point, ROW_HEIGHT, relationPath } from './designer-layout.ts'

const PAD = 40

const xmlText = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/**
 * The diagram as a stand-alone SVG file. Colours are fixed (dark ink on white): the file is opened outside this page,
 * where neither the theme nor the page's stylesheet applies.
 */
export function diagramSvg(o: {
  tables: readonly string[]
  relations: readonly RelationDef[]
  positions: Readonly<Record<string, Point>>
  columns: ReadonlyMap<string, readonly string[]>
  /** Columns marked as their table's display column. */
  display?: ReadonlyMap<string, string>
}): string {
  const at = (table: string): Point => o.positions[table] ?? { x: 0, y: 0 }
  const columnsOf = (table: string) => o.columns.get(table) ?? []
  const width = Math.max(...o.tables.map((n) => at(n).x + BOX_WIDTH)) + PAD
  const height = Math.max(...o.tables.map((n) => at(n).y + boxHeight(columnsOf(n).length))) + PAD
  const lines = o.relations.map(
    (r) => `<path d="${relationPath(r, at, columnsOf)}" fill="none" stroke="#2563eb" stroke-width="1.5"/>`
  )
  const boxes = o.tables.map((name) => {
    const p = at(name)
    const cols = columnsOf(name)
    const rows = cols.map(
      (c, i) =>
        `<text x="8" y="${HEADER_HEIGHT + i * ROW_HEIGHT + 14}" font-size="12" fill="#52525b">${xmlText(
          o.display?.get(name) === c ? `◆ ${c}` : c
        )}</text>`
    )
    return [
      `<g transform="translate(${p.x} ${p.y})">`,
      `<rect width="${BOX_WIDTH}" height="${boxHeight(cols.length)}" rx="4" fill="#ffffff" stroke="#71717a" stroke-width="1.5"/>`,
      `<text x="8" y="18" font-size="12" font-weight="600" fill="#18181b">${xmlText(name)}</text>`,
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
