import type { RowKeyKind } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { ColumnPicker } from './ColumnPicker.tsx'
import { DisplayMenu } from './DisplayMenu.tsx'

export interface BrowseToolbarProps {
  columns: string[]
  visible: string[] | null
  onColumns: (visible: string[]) => void
  keyKind: RowKeyKind
  editable: boolean
  selectedCount: number
  canDelete: boolean
  onDelete: () => void
}

export function BrowseToolbar({
  columns,
  visible,
  onColumns,
  keyKind,
  editable,
  selectedCount,
  canDelete,
  onDelete,
}: BrowseToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-sub">
      <ColumnPicker columns={columns} visible={visible} onChange={onColumns} />
      <DisplayMenu />
      <span>{locale.browse.keyHint[keyKind]}</span>
      {editable ? (
        <>
          <span>{locale.browse.selected(selectedCount)}</span>
          <Button size="sm" variant="danger" disabled={!canDelete} onClick={onDelete}>
            {locale.browse.deleteSelected}
          </Button>
        </>
      ) : null}
    </div>
  )
}
