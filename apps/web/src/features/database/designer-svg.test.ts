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
})
