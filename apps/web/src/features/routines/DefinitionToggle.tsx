import { useState } from 'react'
import { Button } from '@/components/ui/Button.tsx'
import { locale } from '@/config/locale.ts'

/** Collapsible SQL definition (null = the account may not read it). */
export function DefinitionToggle({ definition, label }: { definition: string | null; label: string }) {
  const [open, setOpen] = useState(false)
  if (definition === null)
    return <span className="text-xs text-zinc-500 dark:text-zinc-400">{locale.routines.noDefinition}</span>
  return (
    <div>
      <Button
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${label}: ${open ? locale.routines.hide : locale.routines.show}`}
      >
        {open ? locale.routines.hide : locale.routines.show}
      </Button>
      {open ? (
        <pre className="mt-2 max-h-96 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950">
          {definition}
        </pre>
      ) : null}
    </div>
  )
}
