import { createFileRoute } from '@tanstack/react-router'
import { DatabaseListPage } from '@/features/database/DatabaseListPage.tsx'
import { ServerInfoCard } from '@/features/server/ServerInfoCard.tsx'

export const Route = createFileRoute('/_app/')({ component: ServerHome })

function ServerHome() {
  return (
    <DatabaseListPage>
      <ServerInfoCard />
    </DatabaseListPage>
  )
}
