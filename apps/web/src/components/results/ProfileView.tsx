import type { ProfileStage } from '@tsmyadmin/shared'
import { Table, Td, Th, Tr } from '@/components/ui/Table.tsx'
import { locale } from '@/config/locale.ts'

const t = locale.sql.profiling

/** Where the server spent a statement's time, stage by stage (MySQL / MariaDB `SHOW PROFILE`). */
export function ProfileView({ profile }: { profile: ProfileStage[] | undefined }) {
  if (!profile || profile.length === 0) return null
  const total = profile.reduce((sum, p) => sum + p.seconds, 0)
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-ink-sub">{t.summary(total)}</summary>
      <Table aria-label={t.title} className="mt-1 w-auto">
        <thead>
          <tr>
            <Th>{t.state}</Th>
            <Th className="text-right">{t.seconds}</Th>
          </tr>
        </thead>
        <tbody>
          {profile.map((p, i) => (
            // Stages repeat (e.g. "executing" twice): the position keeps them apart.
            <Tr key={i}>
              <Td>{p.state}</Td>
              <Td className="text-right tabular-nums">{p.seconds.toFixed(6)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </details>
  )
}
