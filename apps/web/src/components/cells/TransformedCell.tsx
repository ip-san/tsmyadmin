import type { Cell, ColumnTransform } from '@tsmyadmin/shared'
import { isBinaryCell, transformLink } from '@tsmyadmin/shared'
import { useState } from 'react'
import { locale } from '@/config/locale.ts'
import { CellValue } from './CellValue.tsx'
import { displayText } from './transform-text.ts'

const bytesOf = (text: string) => Array.from(text, (c) => c.charCodeAt(0))
const startsWith = (head: number[], magic: number[]) => magic.every((b, i) => head[i] === b)

/**
 * The MIME type of an image held in a binary value, told by its first bytes: PNG, JPEG, GIF or WebP, else null.
 * SVG is deliberately absent — it is a document that can carry script and links, not a picture.
 */
export function imageType(base64: string): string | null {
  let head: number[]
  try {
    head = bytesOf(atob(base64.slice(0, 16)))
  } catch {
    return null
  }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, bytesOf('GIF87a')) || startsWith(head, bytesOf('GIF89a'))) return 'image/gif'
  if (startsWith(head, bytesOf('RIFF')) && startsWith(head.slice(8), bytesOf('WEBP'))) return 'image/webp'
  return null
}

function Image({ cell, column }: { cell: { $bin: string }; column: string }) {
  const [broken, setBroken] = useState(false)
  const type = imageType(cell.$bin)
  // A value cut at the size limit, or one that is not an image after all, shows as the usual binary summary.
  if (!type || broken) return <CellValue cell={cell} />
  return (
    <img
      src={`data:${type};base64,${cell.$bin}`}
      alt={locale.transform.imageAlt(column)}
      onError={() => setBroken(true)}
      className="max-h-24 max-w-48 rounded border border-line object-contain"
    />
  )
}

/**
 * A cell shown through its column's display transformation (phpMyAdmin's browser transformations). Anything the
 * transformation cannot show — a NULL, a value that is not a link or not JSON — falls back to the plain value.
 */
export function TransformedCell({ cell, transform }: { cell: Cell; transform: ColumnTransform }) {
  if (cell === null) return <CellValue cell={cell} />
  if (transform.kind === 'image') {
    return isBinaryCell(cell) ? <Image cell={cell} column={transform.column} /> : <CellValue cell={cell} />
  }
  if (transform.kind === 'hex') {
    const shown = displayText(transform, cell)
    return shown === null ? <CellValue cell={cell} /> : <span className="break-all font-mono text-xs">{shown}</span>
  }
  if (typeof cell === 'object') return <CellValue cell={cell} />
  const text = String(cell)
  if (['substring', 'boolean', 'date', 'ipv4', 'affix'].includes(transform.kind)) {
    const shown = displayText(transform, cell)
    // The value as stored stays one hover away (a transformation changes how it looks, not what it is).
    return shown === null ? <CellValue cell={cell} /> : <span title={text}>{shown}</span>
  }
  if (transform.kind === 'link') {
    const href = transformLink(text, transform.template)
    if (!href) return <CellValue cell={cell} />
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="break-all text-blue-700 underline dark:text-blue-300"
      >
        {text}
        <span className="sr-only">{locale.nav.opensNewTab}</span>
      </a>
    )
  }
  try {
    return (
      <pre className="whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(JSON.parse(text), null, 2)}</pre>
    )
  } catch {
    return <CellValue cell={cell} />
  }
}
