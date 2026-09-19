import type { Shape } from './geometry.ts'

export type Project = (p: [number, number]) => [number, number]

const STROKE = '#2563eb'
const FILL = 'rgba(37,99,235,0.2)'
// Characters XML 1.0 cannot carry at all (a control character in a label would make the whole file unreadable).
const xmlEscape = (text: string) =>
  Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
    })
    .join('')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
const num = (n: number) => String(Math.round(n * 100) / 100)

function pathData(points: [number, number][], project: Project): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${project(p).map(num).join(' ')}`).join(' ')
}

/** One shape as SVG elements with their colours written out (a saved file has no page stylesheet to read them from). */
export function shapeSvg(shape: Shape, project: Project, scale: number): string {
  switch (shape.type) {
    case 'point': {
      const [x, y] = project(shape.at)
      return `<circle cx="${num(x)}" cy="${num(y)}" r="4" fill="${STROKE}"/>`
    }
    case 'circle': {
      const [x, y] = project(shape.at)
      return `<circle cx="${num(x)}" cy="${num(y)}" r="${num(Math.max(shape.r * scale, 1))}" fill="${FILL}" stroke="${STROKE}"/>`
    }
    case 'line':
      return `<path d="${pathData(shape.points, project)}" fill="none" stroke="${STROKE}" stroke-width="2"/>`
    case 'polygon':
      return `<path d="${shape.rings.map((ring) => `${pathData(ring, project)} Z`).join(' ')}" fill-rule="evenodd" fill="${FILL}" stroke="${STROKE}"/>`
    default:
      return shape.parts.map((part) => shapeSvg(part, project, scale)).join('')
  }
}

/** The whole picture as a standalone SVG file; a label becomes the shape's tooltip (`<title>`). */
export function gisDocument(
  drawn: { shape: Shape; label: string }[],
  project: Project,
  scale: number,
  width: number,
  height: number
): string {
  const body = drawn
    .map(
      ({ shape, label }) =>
        `<g>${label ? `<title>${xmlEscape(label)}</title>` : ''}${shapeSvg(shape, project, scale)}</g>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#f4f4f5"/>
${body}
</svg>
`
}
