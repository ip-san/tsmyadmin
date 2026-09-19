import type { Cell } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { useState } from 'react'
import { locale } from '@/config/locale.ts'
import { describeCell } from '@/lib/format.ts'
import { useCellDisplay } from './cell-display.ts'

const MAX_PREVIEW = 200
const NUMERIC = /^-?\d{1,40}(?:\.\d{1,40})?(?:[eE][+-]?\d{1,4})?$/
/** Dates, times and timestamps as the servers print them (with optional fraction / zone). */
const TEMPORAL =
  /^-?\d{1,4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}(?::?\d{2})?|Z)?)?$|^-?\d{1,3}:\d{2}(?::\d{2}(?:\.\d+)?)?$/

/** Bytes shown as hex before the rest is summarised: a BLOB would otherwise fill the page. */
const HEX_BYTES = 256

/** The first HEX_BYTES of a binary value as `0x…` hex. */
function hexPreview(b64: string): string {
  const raw = atob(b64)
  let out = '0x'
  for (let i = 0; i < Math.min(raw.length, HEX_BYTES); i++) out += raw.charCodeAt(i).toString(16).padStart(2, '0')
  return out
}

export function CellValue({ cell }: { cell: Cell }) {
  const { display } = useCellDisplay()
  // Null until toggled here: the grid-wide "full text" option decides until then.
  const [toggled, setExpanded] = useState<boolean | null>(null)
  const expanded = toggled ?? display.fullText
  const d = describeCell(cell)
  if (d.kind === 'null') return <span className="italic text-ink-sub">{locale.common.null}</span>
  if (d.kind === 'binary') {
    if (!display.binaryAsHex || !isBinaryCell(cell))
      return <span className="text-xs text-ink-sub">{locale.common.binary(d.bytes)}</span>
    return (
      <span className="break-all font-mono text-xs">
        {hexPreview(cell.$bin)}
        {d.bytes > HEX_BYTES ? <span className="text-ink-sub">{locale.browse.hexMore(d.bytes)}</span> : null}
      </span>
    )
  }
  const note =
    d.kind === 'truncated' ? (
      <span className="whitespace-nowrap text-xs text-ink-sub">{locale.common.truncatedText(d.length)}</span>
    ) : null
  if (d.kind === 'text' && d.empty) return <span className="italic text-ink-sub">{locale.common.empty}</span>
  // A number split across lines reads as two numbers: keep it on one line. BIGINT / DECIMAL travel as strings
  // (for precision) and are exactly the long values that would wrap.
  if (typeof cell === 'number' || NUMERIC.test(d.text) || TEMPORAL.test(d.text)) {
    return <span className="whitespace-nowrap tabular-nums">{d.text}</span>
  }
  // A server-truncated text is always long enough to fold; its note stays visible in both states.
  const long = note !== null || d.text.length > MAX_PREVIEW || d.text.split('\n').length > 3
  if (!long) return <span className="whitespace-pre-wrap break-all">{d.text}</span>
  return (
    <span className="whitespace-pre-wrap break-all">
      {expanded ? d.text : `${d.text.split('\n').slice(0, 3).join('\n').slice(0, MAX_PREVIEW)}…`} {note}
      {note ? ' ' : null}
      <button
        type="button"
        className="whitespace-nowrap text-xs text-blue-700 hover:underline dark:text-blue-300"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded
          ? locale.common.showLess
          : d.kind === 'truncated'
            ? locale.common.showHead(d.text.length)
            : locale.common.showMore(d.text.length)}
      </button>
    </span>
  )
}
