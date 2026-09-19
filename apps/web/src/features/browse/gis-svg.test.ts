import { describe, expect, it } from 'vitest'
import { gisDocument, shapeSvg } from './gis-svg.ts'

const project = ([x, y]: [number, number]): [number, number] => [x * 10, 100 - y * 10]

describe('gisDocument', () => {
  it('writes each kind of shape with its colours, and a label as a tooltip', () => {
    expect(shapeSvg({ type: 'point', at: [1, 2] }, project, 1)).toBe('<circle cx="10" cy="80" r="4" fill="#2563eb"/>')
    expect(
      shapeSvg(
        {
          type: 'line',
          points: [
            [0, 0],
            [1, 1],
          ],
        },
        project,
        1
      )
    ).toContain('d="M 0 100 L 10 90"')
    const polygon = shapeSvg(
      {
        type: 'polygon',
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
      },
      project,
      1
    )
    expect(polygon).toContain('fill-rule="evenodd"')
    expect(polygon).toContain('Z"')
    expect(shapeSvg({ type: 'circle', at: [0, 0], r: 0.01 }, project, 1)).toContain('r="1"')
    const parts = shapeSvg(
      {
        type: 'collection',
        parts: [
          { type: 'point', at: [0, 0] },
          { type: 'point', at: [1, 1] },
        ],
      },
      project,
      1
    )
    expect(parts.match(/<circle/g)).toHaveLength(2)
  })

  it('is a standalone document, and escapes a label that holds markup', () => {
    const doc = gisDocument([{ shape: { type: 'point', at: [0, 0] }, label: 'a <b> & "c"' }], project, 1, 640, 400)
    expect(doc.startsWith('<?xml')).toBe(true)
    expect(doc).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(doc).toContain('<title>a &lt;b&gt; &amp; &quot;c&quot;</title>')
    expect(doc).not.toContain('class=')
  })
})
