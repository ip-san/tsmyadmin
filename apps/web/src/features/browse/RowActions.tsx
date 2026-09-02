import { Copy, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button.tsx'
import { Td } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'

const ICON_BUTTON = '-my-0.5 ml-1 align-middle'

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
      <label className="inline-flex min-h-6 min-w-6 items-center justify-center align-middle">
        <input
          type="checkbox"
          aria-label={locale.rows.selectRow(index + 1)}
          checked={selected}
          disabled={!addressable}
          onChange={onToggle}
        />
      </label>
      <Button
        variant="icon"
        size="icon"
        className={ICON_BUTTON}
        aria-label={locale.rows.editRow(index + 1)}
        aria-haspopup="dialog"
        disabled={!addressable}
        onClick={onEdit}
      >
        <Pencil className="size-3.5" aria-hidden />
      </Button>
      <Button
        variant="icon"
        size="icon"
        className={ICON_BUTTON}
        aria-label={locale.rows.copyRow(index + 1)}
        aria-haspopup="dialog"
        onClick={onCopy}
      >
        <Copy className="size-3.5" aria-hidden />
      </Button>
    </Td>
  )
}
