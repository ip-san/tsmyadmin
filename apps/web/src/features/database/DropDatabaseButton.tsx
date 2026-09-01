import { useState } from 'react'
import { DdlPreviewDialog } from '@/components/ddl/DdlPreviewDialog.tsx'
import { Button } from '@/components/ui/Button.tsx'
import { Dialog } from '@/components/ui/Dialog.tsx'
import { Notice } from '@/components/ui/Feedback.tsx'
import { Field, Input } from '@/components/ui/Field.tsx'
import { locale } from '@/config/locale.ts'
import { useDdlFlow } from '@/lib/ddl.ts'

/** DROP DATABASE with a type-the-name confirmation on top of the usual SQL preview. */
export function DropDatabaseButton({ name, serverDatabase }: { name: string; serverDatabase: string }) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const flow = useDdlFlow(serverDatabase, undefined)
  return (
    <>
      <Button
        size="sm"
        variant="danger"
        onClick={() => setConfirming(true)}
        aria-label={`${name}: ${locale.ddl.titles.dropDatabase}`}
      >
        {locale.ddl.drop}
      </Button>
      <Dialog
        open={confirming}
        title={locale.ddl.titles.dropDatabase}
        onClose={() => {
          setConfirming(false)
          setTyped('')
        }}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{locale.common.cancel}</Button>
            <Button
              variant="danger"
              disabled={typed !== name}
              onClick={() => {
                setConfirming(false)
                setTyped('')
                flow.preview({ op: 'dropDatabase', name })
              }}
            >
              {locale.ddl.submit}
            </Button>
          </>
        }
      >
        <Notice>{locale.ddl.dropDatabaseHint}</Notice>
        <div className="mt-3">
          <Field id="drop-db-confirm" label={locale.ddl.dropDatabaseConfirmName(name)}>
            <Input id="drop-db-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </Dialog>
      <DdlPreviewDialog flow={flow} />
    </>
  )
}
