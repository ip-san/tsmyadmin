/** The presentation properties a drawing needs written into it, since a saved file has none of the page's stylesheets. */
const PROPS = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'fill-rule',
] as const

/**
 * A drawing on the page as a standalone SVG document: every element carries the colours and text style it has on
 * screen (read from the computed style, so the theme's tokens come out as real colours), and a background is put
 * behind it. Nothing is fetched and the page's scripts and classes are left out.
 */
export function standaloneSvg(svg: SVGSVGElement, background: string): { text: string; width: number; height: number } {
  const width = Math.ceil(Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width)
  const height = Math.ceil(Number(svg.getAttribute('height')) || svg.getBoundingClientRect().height)
  const clone = svg.cloneNode(true) as SVGSVGElement
  const from = [svg, ...svg.querySelectorAll('*')]
  const to = [clone, ...clone.querySelectorAll('*')]
  from.forEach((source, i) => {
    const target = to[i] as SVGElement | undefined
    if (!target) return
    const style = getComputedStyle(source)
    for (const prop of PROPS) target.style.setProperty(prop, style.getPropertyValue(prop))
    target.removeAttribute('class')
    target.removeAttribute('aria-hidden')
  })
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`)
  clone.style.removeProperty('color')
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('width', String(width))
  rect.setAttribute('height', String(height))
  rect.setAttribute('fill', background)
  clone.insertBefore(rect, clone.firstChild)
  return {
    text: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`,
    width,
    height,
  }
}
