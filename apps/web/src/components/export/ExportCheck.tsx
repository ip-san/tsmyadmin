import type { ReactNode } from 'react'

export type ExportPatch = (patch: Partial<import('@tsmyadmin/shared').ExportOptions>) => void

export function ExportCheck({
  checked,
  onChange,
  disabled,
  besideField,
  children,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  /** In a row of labelled fields: lined up with their controls (the label above them is 1.25rem; a control is 2.375rem). */
  besideField?: boolean
  children: ReactNode
}) {
  return (
    <label
      className={
        besideField ? 'mt-5 flex min-h-[2.375rem] items-center gap-1 text-sm' : 'flex items-center gap-1 text-sm'
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled ?? false}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  )
}
