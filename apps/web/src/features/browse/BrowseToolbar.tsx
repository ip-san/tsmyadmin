import type { RowKeyKind } from '@tsmyadmin/shared'
import { Button } from '@/components/ui/Button.tsx'
import { PrintButton } from '@/components/ui/PrintButton.tsx'
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
  /** MySQL / MariaDB: time the statement's stages (the toggle is left out where the server has no profiling). */
  profile?: boolean
  onProfile?: (on: boolean) => void
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
  profile,
  onProfile,
}: BrowseToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-sub print:hidden">
      <ColumnPicker columns={columns} visible={visible} onChange={onColumns} />
      <PrintButton />
      <DisplayMenu />
      {onProfile ? (
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={profile === true} onChange={(e) => onProfile(e.target.checked)} />
          {locale.browse.profiling}
        </label>
      ) : null}
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
