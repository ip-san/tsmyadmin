import type { Cell } from '@tsmyadmin/shared'
import { useState } from 'react'
import { locale } from '@/config/locale.ts'
import { describeCell } from '@/lib/format.ts'

const MAX_PREVIEW = 200

export function CellValue({ cell }: { cell: Cell }) {
  const [expanded, setExpanded] = useState(false)
  const d = describeCell(cell)
  if (d.kind === 'null') return <span className="italic text-zinc-500 dark:text-zinc-400">{locale.common.null}</span>
  if (d.kind === 'binary')
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.common.binary(d.bytes)}</span>
  if (d.empty) return <span className="italic text-zinc-500 dark:text-zinc-400">{locale.common.empty}</span>
  // A number split across lines reads as two numbers: keep it on one line (values are short anyway).
  if (typeof cell === 'number') return <span className="whitespace-nowrap tabular-nums">{d.text}</span>
  const long = d.text.length > MAX_PREVIEW || d.text.split('\n').length > 3
  if (!long) return <span className="whitespace-pre-wrap break-all">{d.text}</span>
  return (
    <span className="whitespace-pre-wrap break-all">
      {expanded ? d.text : `${d.text.split('\n').slice(0, 3).join('\n').slice(0, MAX_PREVIEW)}…`}{' '}
      <button
        type="button"
        className="text-xs text-blue-700 hover:underline dark:text-blue-300"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        {expanded ? locale.common.showLess : locale.common.showMore(d.text.length)}
      </button>
    </span>
  )
}
