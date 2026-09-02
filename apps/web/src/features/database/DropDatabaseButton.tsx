import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'

/** DROP DATABASE through the SQL preview, which requires retyping the database name before it can run. */
export function DropDatabaseButton({ name, serverDatabase }: { name: string; serverDatabase: string }) {
  const flow = useDdlFlow(serverDatabase, undefined)
  return (
    <>
      <Button
        size="sm"
        variant="danger"
        onClick={() => flow.preview({ op: 'dropDatabase', name })}
        aria-label={`${name}: ${locale.ddl.titles.dropDatabase}`}
      >
        {locale.ddl.drop}
      </Button>
      <DdlPreviewDialog flow={flow} />
    </>
  )
}
