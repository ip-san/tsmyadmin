import { createFileRoute } from '@tanstack/react-router'
import { Notice } from '@/components/ui/Feedback.tsx'
import { locale } from '@/config/locale.ts'

export const Route = createFileRoute('/_app/db/$db/table/$table/insert')({
  component: () => <Notice>{locale.common.comingSoon}</Notice>,
})
