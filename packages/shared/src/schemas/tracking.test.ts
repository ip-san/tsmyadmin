import { describe, expect, it } from 'vitest'
import { lineDiff, MAX_DIFF_LINES } from './tracking.ts'

const render = (lines: ReturnType<typeof lineDiff>) =>
  lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)

describe('lineDiff', () => {
  it('keeps what is common and marks what changed', () => {
    const before = 'CREATE TABLE t (\n  id int,\n  name text\n)'
    const after = 'CREATE TABLE t (\n  id int,\n  name varchar(20),\n  age int\n)'
    expect(render(lineDiff(before, after))).toEqual([
      ' CREATE TABLE t (',
      '   id int,',
      '-  name text',
      '+  name varchar(20),',
      '+  age int',
      ' )',
    ])
  })

  it('reports nothing changed for the same text, and everything for text with nothing in common', () => {
    expect(lineDiff('a\nb', 'a\nb').every((l) => l.kind === 'same')).toBe(true)
    expect(render(lineDiff('a', 'b'))).toEqual(['-a', '+b'])
    expect(render(lineDiff('', 'x'))).toEqual(['-', '+x'])
  })

  it('does not build a quadratic table for huge text', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    const diff = lineDiff(big, `${big}\nmore`)
    expect(diff.filter((l) => l.kind === 'same')).toHaveLength(0)
    expect(diff).toHaveLength(2 * (MAX_DIFF_LINES + 1) + 1)
  })
})
