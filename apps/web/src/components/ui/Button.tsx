import type { ButtonHTMLAttributes, Ref } from 'react'
import { cn } from '@/lib/cn.ts'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900',
  secondary:
    'bg-white text-zinc-800 border border-zinc-300 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-700',
  danger:
    'bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700 disabled:bg-red-300 dark:disabled:bg-red-900',
  ghost: 'bg-transparent text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
}
const SIZES: Record<Size, string> = { sm: 'px-2 py-1 text-xs', md: 'px-3 py-1.5 text-sm' }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  ref?: Ref<HTMLButtonElement>
}

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  // WebKit does not focus a clicked button; a dialog opener must hold focus so the dialog can hand it back.
  const opensDialog = rest['aria-haspopup'] === 'dialog'
  return (
    <button
      type={type}
      onMouseDown={opensDialog ? (e) => e.currentTarget.focus() : undefined}
      className={cn(
        'inline-flex items-center gap-1 rounded font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...rest}
    />
  )
}
