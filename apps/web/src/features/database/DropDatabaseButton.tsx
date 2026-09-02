import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import type { DdlFlow } from '@/lib/ddl.ts'

/**
 * DROP DATABASE through the page-level preview flow (the dialog and its success notice live on the page, not in
 * the row, which disappears when the drop succeeds). The preview requires retyping the database name.
 */
export function DropDatabaseButton({ name, flow }: { name: string; flow: DdlFlow }) {
  return (
    <Button
      size="sm"
      variant="danger"
      aria-haspopup="dialog"
      onClick={() => flow.preview({ op: 'dropDatabase', name })}
      aria-label={`${name}: ${locale.ddl.titles.dropDatabase}`}
    >
      {locale.ddl.drop}
    </Button>
  )
}
