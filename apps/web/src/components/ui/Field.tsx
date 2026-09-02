import {
  Children,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn.ts'

const control =
  'w-full rounded border border-zinc-500 bg-white px-2 py-1.5 text-sm text-zinc-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-60'

export function Input({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(control, className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, className)} {...rest} />
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  // Tailwind emits `w-auto` before `w-full`, so a caller's width class must replace the control's, not join it.
  const base = className && /\bw-/.test(className) ? control.replace('w-full ', '') : control
  return <select className={cn(base, className)} {...rest} />
}

function Label({ children, htmlFor, className }: { children: ReactNode; htmlFor: string; className?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300', className)}
    >
      {children}
    </label>
  )
}

export function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string
  label: string
  children: ReactNode
  hint?: string
}) {
  // The hint is associated with the (single) control automatically so screen readers read it with the field.
  const hintId = hint ? `${id}-hint` : undefined
  const control =
    hintId && Children.count(children) === 1 && isValidElement<{ 'aria-describedby'?: string }>(children)
      ? cloneElement(children, { 'aria-describedby': children.props['aria-describedby'] ?? hintId })
      : children
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
