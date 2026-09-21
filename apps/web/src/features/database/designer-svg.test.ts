import type { RelationDef } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { diagramSvg } from './designer-svg.ts'

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

describe('diagramSvg', () => {
  it('draws each table as a box, each key as a line, and marks the display column', () => {
    const svg = diagramSvg({
      tables: ['users', 'posts'],
      relations: [relation],
      positions: { users: { x: 0, y: 0 }, posts: { x: 300, y: 0 } },
      columns: new Map([
        ['users', ['id', 'name']],
        ['posts', ['user_id']],
      ]),
      display: new Map([['users', 'name']]),
    })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.match(/<rect /g)).toHaveLength(3)
    expect(svg.match(/<path /g)).toHaveLength(1)
    expect(svg).toContain('◆ name')
    expect(svg).toContain('>id<')
  })

  it('escapes names, so a table called <b> cannot add markup to the file', () => {
    const svg = diagramSvg({
      tables: ['<b>&"'],
      relations: [],
      positions: {},
      columns: new Map([['<b>&"', ['a<']]]),
    })
    expect(svg).toContain('&lt;b&gt;&amp;&quot;')
    expect(svg).not.toContain('<b>')
  })

  it('cuts a name that would run over its box and names it in full in a tooltip', () => {
    const long = 'a_table_name_that_is_far_too_long_for_a_box_two_hundred_pixels_wide'
    const column = 'a_column_name_that_is_also_far_too_long_for_the_room_the_box_has_for_it'
    const svg = diagramSvg({
      tables: [long],
      relations: [],
      positions: { [long]: { x: 0, y: 0 } },
      columns: new Map([[long, [column, 'id']]]),
    })
    expect(svg).toContain(`<title>${long}</title>`)
    expect(svg).toContain(`<title>${column}</title>`)
    // The drawn text is the cut one; a name that fits has no tooltip.
    expect(svg).toContain('…')
    expect(svg).not.toContain('<title>id</title>')
    // The text of the header is the cut name (the whole one is only in the title beside it).
    expect(svg).not.toContain(`fill="#18181b">${long}`)
  })
})
