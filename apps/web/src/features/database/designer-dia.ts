import {
  BOX_WIDTH,
  boxHeight,
  DEFAULT_VIEW,
  type DiagramInput,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  relationLabel,
  relationRoute,
  routeMiddle,
} from './designer-layout.ts'

/** Dia counts in centimetres; the diagram is laid out in pixels. */
const CM = 1 / 30
const PAD = 40

const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
/** Characters XML 1.0 cannot carry at all (control characters other than tab and newline) are dropped. */
const clean = (s: string) =>
  [...s].filter((ch) => (ch.codePointAt(0) ?? 0) >= 32 || ch === '\t' || ch === '\n').join('')
const cm = (v: number) => Number((v * CM).toFixed(3))
const point = (x: number, y: number) => `<dia:point val="${cm(x)},${cm(y)}"/>`

/**
 * The diagram as a Dia file (the diagram editor's own XML): each table a box with its name and columns as text, each
 * key a Bézier line. It is plain Standard objects, so the file opens in Dia and can be edited there.
 */
export function diagramDia(o: DiagramInput): string {
  const at = (table: string) => o.positions[table] ?? { x: 0, y: 0 }
  const view = o.view ?? DEFAULT_VIEW
  const columnsOf = (table: string) => (view.compact ? [] : (o.columns.get(table) ?? []))
  let id = 0
  const nextId = () => `O${id++}`
  const objects: string[] = []
  const text = (label: string, x: number, y: number, bold: boolean) =>
    [
      `<dia:object type="Standard - Text" version="1" id="${nextId()}">`,
      `<dia:attribute name="obj_pos">${point(x, y)}</dia:attribute>`,
      '<dia:attribute name="text"><dia:composite type="text">',
      `<dia:attribute name="string"><dia:string>#${xml(clean(label))}#</dia:string></dia:attribute>`,
      `<dia:attribute name="font"><dia:font family="sans" style="${bold ? 80 : 0}" name="Helvetica${bold ? '-Bold' : ''}"/></dia:attribute>`,
      `<dia:attribute name="height"><dia:real val="${cm(11)}"/></dia:attribute>`,
      `<dia:attribute name="pos">${point(x, y)}</dia:attribute>`,
      '<dia:attribute name="color"><dia:color val="#000000"/></dia:attribute>',
      '<dia:attribute name="alignment"><dia:enum val="0"/></dia:attribute>',
      '</dia:composite></dia:attribute>',
      '</dia:object>',
    ].join('')
  for (const name of o.tables) {
    const p = at(name)
    const cols = columnsOf(name)
    objects.push(
      [
        `<dia:object type="Standard - Box" version="0" id="${nextId()}">`,
        `<dia:attribute name="obj_pos">${point(p.x, p.y)}</dia:attribute>`,
        `<dia:attribute name="elem_corner">${point(p.x, p.y)}</dia:attribute>`,
        `<dia:attribute name="elem_width"><dia:real val="${cm(BOX_WIDTH)}"/></dia:attribute>`,
        `<dia:attribute name="elem_height"><dia:real val="${cm(boxHeight(cols.length, view.compact))}"/></dia:attribute>`,
        '<dia:attribute name="inner_color"><dia:color val="#ffffff"/></dia:attribute>',
        '</dia:object>',
      ].join(''),
      text(name, p.x + 6, p.y + 14, true),
      ...cols.map((c, i) =>
        text(o.display?.get(name) === c ? `◆ ${c}` : c, p.x + 6, p.y + HEADER_HEIGHT + i * ROW_HEIGHT + 12, false)
      )
    )
  }
  for (const r of view.showLines ? o.relations : []) {
    const route = relationRoute(r, at, columnsOf, view.lineStyle, view.compact)
    const points =
      route.kind === 'curve'
        ? `<dia:attribute name="bez_points">${point(route.from.x, route.from.y)}${point(route.control1.x, route.control1.y)}${point(route.control2.x, route.control2.y)}${point(route.to.x, route.to.y)}</dia:attribute>`
        : `<dia:attribute name="poly_points">${route.points.map((p) => point(p.x, p.y)).join('')}</dia:attribute>`
    objects.push(
      [
        `<dia:object type="${route.kind === 'curve' ? 'Standard - BezierLine' : 'Standard - PolyLine'}" version="0" id="${nextId()}">`,
        points,
        '<dia:attribute name="line_color"><dia:color val="#2563eb"/></dia:attribute>',
        '</dia:object>',
      ].join('')
    )
    if (view.lineLabels) {
      const mid = routeMiddle(route)
      objects.push(text(relationLabel(r), mid.x, mid.y - 4, false))
    }
  }
  const width = Math.max(0, ...o.tables.map((n) => at(n).x + BOX_WIDTH)) + PAD
  const height = Math.max(0, ...o.tables.map((n) => at(n).y + boxHeight(columnsOf(n).length, view.compact))) + PAD
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<dia:diagram xmlns:dia="http://www.lysator.liu.se/~alla/dia/">',
    `<dia:diagramdata><dia:attribute name="background"><dia:color val="#ffffff"/></dia:attribute><dia:attribute name="extents"><dia:rectangle val="0,0;${cm(width)},${cm(height)}"/></dia:attribute></dia:diagramdata>`,
    '<dia:layer name="Background" visible="true" active="true">',
    ...objects,
    '</dia:layer>',
    '</dia:diagram>',
  ].join('\n')
}
