import { Copy, Pencil, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { Td } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'

const ICON_BUTTON = '-my-0.5 ml-1 align-middle'

/** Leading cell of a browse row: select checkbox, edit, duplicate and delete buttons (24px targets). */
export function RowActions({
  index,
  addressable,
  selected,
  onToggle,
  onEdit,
  onCopy,
  onDelete,
}: {
  index: number
  /** False when the row has no usable key (cannot be selected or edited). */
  addressable: boolean
  selected: boolean
  onToggle: () => void
  onEdit: () => void
  onCopy: () => void
  onDelete: () => void
}) {
  const reasonId = useId()
  return (
    <Td className="whitespace-nowrap">
      <label
        className="inline-flex min-h-6 min-w-6 items-center justify-center align-middle"
        title={addressable ? undefined : locale.rows.notAddressable}
      >
        <input
          type="checkbox"
          aria-label={locale.rows.selectRow(index + 1)}
          aria-describedby={addressable ? undefined : reasonId}
          checked={selected}
          disabled={!addressable}
          onChange={onToggle}
        />
      </label>
      {addressable ? null : (
        <span id={reasonId} hidden>
          {locale.rows.notAddressable}
        </span>
      )}
      <Button
        variant="icon"
        size="icon"
        className={ICON_BUTTON}
        aria-label={locale.rows.editRow(index + 1)}
        aria-haspopup="dialog"
        disabled={!addressable}
        title={addressable ? undefined : locale.rows.notAddressable}
        aria-describedby={addressable ? undefined : reasonId}
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
      {/* Deleting one row should not mean ticking its box and hunting for the toolbar button: phpMyAdmin puts a
          delete on every row, and anyone arriving from it looks for one here. */}
      <Button
        variant="icon"
        size="icon"
        className={cn(ICON_BUTTON, 'enabled:hover:text-critical')}
        aria-label={locale.rows.deleteRow(index + 1)}
        aria-haspopup="dialog"
        disabled={!addressable}
        title={addressable ? undefined : locale.rows.notAddressable}
        aria-describedby={addressable ? undefined : reasonId}
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </Button>
    </Td>
  )
}
