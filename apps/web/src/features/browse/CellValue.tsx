import type { Cell } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import { describeCell } from '@/lib/format.ts'

const MAX_PREVIEW = 200

export function CellValue({ cell }: { cell: Cell }) {
  const d = describeCell(cell)
  if (d.kind === 'null') return <span className="italic text-zinc-400 dark:text-zinc-500">{locale.common.null}</span>
  if (d.kind === 'binary')
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.common.binary(d.bytes)}</span>
  if (d.empty) return <span className="italic text-zinc-400 dark:text-zinc-500">{locale.common.empty}</span>
  const long = d.text.length > MAX_PREVIEW
  return (
    <span className="whitespace-pre-wrap break-all" title={long ? d.text.slice(0, 2000) : undefined}>
      {long ? `${d.text.slice(0, MAX_PREVIEW)}…` : d.text}
    </span>
  )
}
