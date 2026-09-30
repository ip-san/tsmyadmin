import { createFileRoute } from '@tanstack/react-router'
import { DatabaseListPage } from '@/features/database/DatabaseListPage.tsx'

export const Route = createFileRoute('/_app/')({ component: DatabaseListPage })
