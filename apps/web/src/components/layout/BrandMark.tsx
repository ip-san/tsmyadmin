import { cn } from '@/lib/cn.ts'

/**
 * The product's mark: three stacked rows, read as both a table and a database's discs. Drawn inline rather
 * than loaded, so it costs no request and takes the brand colour from the theme.
 */
export function BrandMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      className={cn('shrink-0 text-brand', className)}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-hidden
    >
      <rect x="1" y="1" width="30" height="30" rx="8" className="fill-brand" />
      <rect x="7" y="9" width="18" height="3.5" rx="1.75" className="fill-white" opacity="0.95" />
      <rect x="7" y="14.25" width="18" height="3.5" rx="1.75" className="fill-white" opacity="0.7" />
      <rect x="7" y="19.5" width="11" height="3.5" rx="1.75" className="fill-white" opacity="0.45" />
    </svg>
  )
}
