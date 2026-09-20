import { Star } from 'lucide-react'
import { locale } from '@/config/locale.ts'
import { type TableShortcut, useTableShortcuts } from '@/lib/table-shortcuts.ts'

/** The star that adds a table to the favorites list (per browser and connection) or takes it out. */
export function FavoriteStar({ table: ref, label }: { table: TableShortcut; label?: string }) {
  const shortcuts = useTableShortcuts()
  const favorite = shortcuts.isFavorite(ref)
  const text = favorite ? locale.nav.unfavorite : locale.nav.favorite
  return (
    <button
      type="button"
      aria-pressed={favorite}
      onClick={() => shortcuts.toggleFavorite(ref)}
      className="rounded p-1 text-ink-sub hover:text-ink"
      title={text}
    >
      <Star
        aria-hidden="true"
        className={favorite ? 'size-4 fill-amber-400 text-amber-500 dark:fill-amber-300 dark:text-amber-300' : 'size-4'}
      />
      <span className="sr-only">{label ? `${label}: ${text}` : text}</span>
    </button>
  )
}
