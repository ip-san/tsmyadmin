import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/cn.ts'

/** A mouse convenience around the file input (the input itself stays the keyboard and screen-reader route). Hands over the first file dropped. */
export function FileDropZone({ onFile, children }: { onFile: (file: File) => void; children: ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (file) onFile(file)
      }}
      className={cn('rounded border border-dashed p-3', over ? 'border-brand bg-brand/10' : 'border-line-strong')}
    >
      {children}
    </div>
  )
}
