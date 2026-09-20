import { describe, expect, it } from 'vitest'
import { type SafeNode, safeHref, sanitizeHtml } from './sanitize-html.ts'

/** Everything in a result, as a string that shows any tag, attribute or text that got through. */
function flat(nodes: SafeNode[]): string {
  return nodes
    .map((n) =>
      n.type === 'text' ? n.text : `<${n.tag}${n.href ? ` href=${n.href}` : ''}>${flat(n.children)}</${n.tag}>`
    )
    .join('')
}

describe('sanitizeHtml', () => {
  it('keeps formatting from the allowlist', () => {
    expect(flat(sanitizeHtml('<p>a <b>b</b> <em>c</em></p><ul><li>x</li></ul>'))).toBe(
      '<p>a <b>b</b> <em>c</em></p><ul><li>x</li></ul>'
    )
    expect(flat(sanitizeHtml('<table><tr><td>1</td></tr></table>'))).toBe(
      '<table><tbody><tr><td>1</td></tr></tbody></table>'
    )
  })

  it('does not draw an image with an error handler, or its handler', () => {
    const out = flat(sanitizeHtml('<img src="x" onerror="alert(1)">after'))
    expect(out).toBe('after')
    expect(out).not.toMatch(/img|onerror|alert/)
  })

  it('drops script and style with their content', () => {
    const out = flat(
      sanitizeHtml('a<script>alert(1)</script>b<style>body{display:none}</style>c<iframe src="//x"></iframe>')
    )
    expect(out).toBe('abc')
  })

  it('drops every attribute but an http(s) href, and unwraps what is not allowed', () => {
    expect(flat(sanitizeHtml('<p onclick="x()" style="color:red" class="c" id="i">t</p>'))).toBe('<p>t</p>')
    expect(flat(sanitizeHtml('<div><span>t</span></div>'))).toBe('t')
    expect(flat(sanitizeHtml('<a href="https://example.com/a" onclick="x()" target="_top">go</a>'))).toBe(
      '<a href=https://example.com/a>go</a>'
    )
  })

  it('drops a link that is not http(s)', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<b>x</b>',
      '//evil.example',
      '/x',
      ' vbscript:x',
    ]) {
      expect(flat(sanitizeHtml(`<a href="${href}">t</a>`))).toBe('<a>t</a>')
    }
  })

  it('shows tags it does not know as text, not as markup', () => {
    expect(flat(sanitizeHtml('1 &lt; 2 &lt;script&gt;x&lt;/script&gt;'))).toBe('1 < 2 <script>x</script>')
  })

  it('stops at a bounded size', () => {
    expect(sanitizeHtml('<p>x</p>'.repeat(5000)).length).toBeLessThan(2001)
  })
})

describe('safeHref', () => {
  it('reads http and https only', () => {
    expect(safeHref('https://a.example/b?c=d')).toBe('https://a.example/b?c=d')
    expect(safeHref('mailto:a@b')).toBeUndefined()
    expect(safeHref(null)).toBeUndefined()
  })
})
