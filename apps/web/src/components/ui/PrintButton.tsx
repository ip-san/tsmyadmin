import { Printer } from 'lucide-react'
import { locale } from '@/config/locale.ts'
import { Button } from './Button.tsx'

/** Prints the list on the page: the menus and the columns of controls are left off the paper (see index.css). */
export function PrintButton() {
  return (
    <Button size="sm" className="print:hidden" onClick={() => window.print()}>
      <Printer className="size-3" aria-hidden />
      {locale.common.printList}
    </Button>
  )
}
