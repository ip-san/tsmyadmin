import { createElement, type ReactNode } from 'react'
import { locale } from '@/config/locale.ts'
import { type SafeNode, sanitizeHtml } from './sanitize-html.ts'

function render(nodes: SafeNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.text
    const key = `${n.tag}-${i}`
    if (n.tag === 'br') return <br key={key} />
    if (n.tag === 'a') {
      return n.href ? (
        <a
          key={key}
          href={n.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-blue-700 underline dark:text-blue-300"
        >
          {render(n.children)}
          <span className="sr-only">{locale.nav.opensNewTab}</span>
        </a>
      ) : (
        <span key={key}>{render(n.children)}</span>
      )
    }
    return createElement(n.tag, { key }, ...render(n.children))
  })
}

/** A cell holding markup, shown as the formatted text the allowlist keeps (see sanitizeHtml). */
export function HtmlCell({ text }: { text: string }) {
  return (
    <div className="whitespace-normal break-words font-sans text-sm [&_table]:border [&_td]:border [&_td]:px-1 [&_th]:border [&_th]:px-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
      {render(sanitizeHtml(text))}
    </div>
  )
}
