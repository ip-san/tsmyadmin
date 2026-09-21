import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { diagramDia } from './designer-dia.ts'
import { diagramEps } from './designer-eps.ts'

const relation: RelationDef = {
  table: 'posts',
  name: 'fk',
  columns: ['user_id'],
  refNamespace: { database: 'app' },
  refTable: 'users',
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
}
const input = {
  tables: ['users', 'posts'],
  relations: [relation],
  positions: { users: { x: 0, y: 0 }, posts: { x: 300, y: 0 } },
  columns: new Map([
    ['users', ['id', 'name']],
    ['posts', ['user_id']],
  ]),
  display: new Map([['users', 'name']]),
}

describe('diagramEps', () => {
  it('is an EPS file with a bounding box, one box per table and one curve per key', () => {
    const eps = diagramEps(input)
    expect(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0\n')).toBe(true)
    expect(eps).toMatch(/%%BoundingBox: 0 0 \d+ \d+/)
    expect(eps.match(/rectstroke/g)).toHaveLength(2)
    expect(eps.match(/curveto/g)).toHaveLength(1)
    expect(eps).toContain('(users) show')
    expect(eps).toContain('(* name) show')
    expect(eps.trimEnd().endsWith('%%EOF')).toBe(true)
  })

  it('escapes what would end a string, and writes anything outside ASCII as ?', () => {
    const eps = diagramEps({
      tables: ['a(b)\\c'],
      relations: [],
      positions: {},
      columns: new Map([['a(b)\\c', ['名前']]]),
    })
    expect(eps).toContain('(a\\(b\\)\\\\c) show')
    expect(eps).toContain('(??) show')
  })
})

describe('diagramDia', () => {
  it('is a dia:diagram with a box and text per table and a Bézier line per key', () => {
    const dia = diagramDia(input)
    expect(dia.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<dia:diagram ')).toBe(true)
    expect(dia.match(/type="Standard - Box"/g)).toHaveLength(2)
    expect(dia.match(/type="Standard - BezierLine"/g)).toHaveLength(1)
    expect(dia).toContain('<dia:string>#users#</dia:string>')
    expect(dia).toContain('<dia:string>#◆ name#</dia:string>')
    // A Bézier line is a start point, two controls and an end point: four in all.
    expect(dia.match(/<dia:attribute name="bez_points">(<dia:point [^>]*\/>){4}<\/dia:attribute>/g)).toHaveLength(1)
  })

  it('escapes markup in names and drops characters XML cannot hold', () => {
    const dia = diagramDia({
      tables: ['<b>&'],
      relations: [],
      positions: {},
      columns: new Map([['<b>&', [`a${String.fromCodePoint(1)}b`]]]),
    })
    expect(dia).toContain('#&lt;b&gt;&amp;#')
    expect(dia).toContain('#ab#')
    expect(dia).not.toContain('<b>')
  })
})

describe('the drawing options in the exports', () => {
  const view = {
    compact: true,
    snap: false,
    fitWidth: false,
    lineStyle: 'polyline' as const,
    lineLabels: true,
    showLines: true,
  }

  it('draws right-angled lines with their label, and boxes with only their name, in every format', () => {
    const eps = diagramEps({ ...input, view })
    expect(eps).toContain('lineto')
    expect(eps).not.toContain('curveto')
    expect(eps).toContain('(user_id ? id) dup stringwidth')
    expect(eps).not.toContain('(name) show')
    const dia = diagramDia({ ...input, view })
    expect(dia).toContain('Standard - PolyLine')
    expect(dia).not.toContain('Standard - BezierLine')
    expect(dia).toContain('poly_points')
    expect(dia).not.toContain('<dia:string>#name#</dia:string>')
  })

  it('leaves the lines out when they are hidden', () => {
    const hidden = { ...view, showLines: false }
    expect(diagramEps({ ...input, view: hidden })).not.toMatch(/curveto| lineto/)
    expect(diagramDia({ ...input, view: hidden })).not.toContain('Line')
  })
})

describe('boxes as wide as their names', () => {
  const long = 'a_very_long_column_name_that_needs_room'
  const wide = {
    ...input,
    columns: new Map([
      ['users', ['id', long]],
      ['posts', ['user_id']],
    ]),
    display: new Map<string, string>(),
  }
  const view = {
    compact: false,
    snap: false,
    fitWidth: true,
    lineStyle: 'curve' as const,
    lineLabels: false,
    showLines: true,
  }

  it('draws the whole name in a wider box in every format, and keeps the fixed width otherwise', () => {
    expect(diagramEps({ ...wide, view })).toContain(`(${long}) show`)
    expect(diagramDia({ ...wide, view })).toContain(`#${long}#`)
    expect(diagramEps({ ...wide, view: { ...view, fitWidth: false } })).not.toContain(`(${long}) show`)
  })
})
