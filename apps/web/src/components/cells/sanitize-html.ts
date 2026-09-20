/** A piece of sanitised markup: only what the allowlist below lets through, as plain data (never as an HTML string). */
export type SafeNode =
  | { type: 'text'; text: string }
  | { type: 'el'; tag: AllowedTag; href?: string; children: SafeNode[] }

const ALLOWED_TAGS = [
  'p',
  'b',
  'i',
  'u',
  'em',
  'strong',
  'a',
  'ul',
  'ol',
  'li',
  'br',
  'code',
  'pre',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
] as const
type AllowedTag = (typeof ALLOWED_TAGS)[number]
const ALLOWED = new Set<string>(ALLOWED_TAGS)

/** Elements whose content is code or an embedded document, not text: dropped with everything inside. */
const DROPPED = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'object',
  'embed',
  'noscript',
  'template',
  'svg',
  'math',
])

const MAX_NODES = 2000
const MAX_DEPTH = 24

/** An http(s) address, written in full: a `javascript:` or `data:` one, or a relative one, is not a link here. */
export function safeHref(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * The markup of a cell as safe nodes. The text is parsed into an inert document (no script runs, no image loads),
 * then only elements on the allowlist are copied over — with no attributes at all but a link's http(s) `href` — and
 * everything else is unwrapped to its text, or dropped with its content for script-like elements. Nothing is ever
 * put into the page as a string, so what is not copied cannot reach it.
 */
export function sanitizeHtml(html: string): SafeNode[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let budget = MAX_NODES
  const walk = (parent: Node, depth: number): SafeNode[] => {
    const out: SafeNode[] = []
    for (const node of Array.from(parent.childNodes)) {
      if (budget-- <= 0 || depth > MAX_DEPTH) break
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) out.push({ type: 'text', text: node.textContent })
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element
        const tag = el.tagName.toLowerCase()
        if (DROPPED.has(tag)) continue
        const children = walk(el, depth + 1)
        if (!ALLOWED.has(tag)) out.push(...children)
        else {
          const href = tag === 'a' ? safeHref(el.getAttribute('href')) : undefined
          out.push({ type: 'el', tag: tag as AllowedTag, ...(href ? { href } : {}), children })
        }
      }
    }
    return out
  }
  return walk(doc.body, 0)
}
