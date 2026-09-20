import type { ReactNode } from 'react'

export type ExportPatch = (patch: Partial<import('@tsmyadmin/shared').ExportOptions>) => void

export function ExportCheck({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
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
