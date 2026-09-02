import { Copy, Pencil } from 'lucide-react'
import { Td } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'

const ICON_BUTTON =
  '-my-0.5 ml-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded align-middle text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800'

/** Leading cell of a browse row: select checkbox, edit and duplicate buttons (24px targets). */
export function RowActions({
  index,
  addressable,
  selected,
  onToggle,
  onEdit,
  onCopy,
}: {
  index: number
  /** False when the row has no usable key (cannot be selected or edited). */
  addressable: boolean
  selected: boolean
  onToggle: () => void
  onEdit: () => void
  onCopy: () => void
}) {
  return (
    <Td className="whitespace-nowrap">
      <input
        type="checkbox"
        aria-label={locale.rows.selectRow(index + 1)}
        checked={selected}
        disabled={!addressable}
        onChange={onToggle}
      />
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label={locale.rows.editRow(index + 1)}
        disabled={!addressable}
        onClick={onEdit}
      >
        <Pencil className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={ICON_BUTTON} aria-label={locale.rows.copyRow(index + 1)} onClick={onCopy}>
        <Copy className="size-3.5" aria-hidden />
      </button>
    </Td>
  )
}
