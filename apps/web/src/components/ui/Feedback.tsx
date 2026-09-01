import type { ReactNode } from 'react'
import { locale } from '@/config/locale.ts'
import { cn } from '@/lib/cn.ts'
import { errorMessage } from '@/lib/format.ts'

export function Spinner({ label = locale.common.loading }: { label?: string }) {
  return (
    <output className="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400" aria-live="polite">
      <span className="size-4 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600 dark:border-zinc-600 dark:border-t-blue-400" />
      {label}
    </output>
  )
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200',
        className
      )}
    >
      <strong className="mr-1">{locale.common.error}:</strong>
      {errorMessage(error)}
    </div>
  )
}

export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
        className
      )}
    >
      {children}
    </div>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'info' | 'warn' }) {
  const tones = {
    neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
  }
  return <span className={cn('inline-block rounded px-1.5 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>
}
