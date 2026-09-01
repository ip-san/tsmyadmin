import type { DdlOp } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'
import type { DdlFlow } from '@/lib/ddl.ts'
import { PreviewDialog } from './PreviewDialog.tsx'

const DESTRUCTIVE = new Set<DdlOp['op']>(['dropTable', 'truncateTable', 'dropColumn', 'dropIndex'])

export function DdlPreviewDialog({ flow }: { flow: DdlFlow }) {
  return (
    <PreviewDialog
      flow={flow}
      title={(op) => locale.ddl.titles[op.op]}
      destructive={(op) => DESTRUCTIVE.has(op.op)}
      hint={locale.ddl.previewHint}
    />
  )
}
