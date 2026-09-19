import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { ServerTabs } from '@/components/layout/ServerTabs.tsx'
import { locale } from '@/config/locale.ts'
import { DiagnosticReport } from '@/features/server/DiagnosticReport.tsx'
import { ServerCatalogPage } from '@/features/server/ServerCatalogPage.tsx'

export const Route = createFileRoute('/_app/engines')({ component: Page })

function Page() {
  const { session } = useRouteContext({ from: '/_app' })
  return (
    <>
      <ServerTabs tab={locale.catalog.titles.engines[session.dialect]} />
      <ServerCatalogPage kind="engines" dialect={session.dialect} />
      {session.dialect === 'mysql' ? (
        <details className="mt-4 rounded border border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">{locale.diagnostics.innodb}</summary>
          <div className="mt-2">
            <DiagnosticReport kind="engineStatus" title={locale.diagnostics.innodb} />
          </div>
        </details>
      ) : null}
    </>
  )
}
