import { useRouteContext } from '@tanstack/react-router'
import type { DesignerPage, DesignerPageBody } from '@tsmyadmin/shared'
import { NamedListPanel } from '@/components/panels/NamedListPanel.tsx'
import { locale } from '@/config/locale.ts'
import { designerPagesQuery, listDesignerPages, mutations } from '@/lib/queries.ts'
import { useNamedList } from '@/lib/use-named-list.ts'
import type { Point } from './designer-layout.ts'
import { deleteDesignerPage, designerPagesFor, loadDesignerPages, saveDesignerPage } from './designer-pages.ts'

const t = locale.designer.pages

/**
 * phpMyAdmin's Designer pages: the diagram's layout kept under a name, for this database, so a large one can have
 * several views. Kept with the account where the deployment can (as bookmarks are), otherwise in this browser.
 */
export function DesignerPages({
  db,
  schema,
  positions,
  allColumns,
  onLoad,
}: {
  db: string
  schema: string | undefined
  positions: Record<string, Point>
  allColumns: boolean
  onLoad: (page: DesignerPage) => void
}) {
  const { session } = useRouteContext({ from: '/_app' })
  const scope = `${session.dialect}.${session.host}.${session.port}`
  const list = useNamedList<DesignerPage, DesignerPageBody>({
    onServer: session.savedQueries === 'server',
    query: { queryKey: designerPagesQuery.queryKey, queryFn: listDesignerPages },
    saveOnServer: (name, body) => mutations.saveDesignerPage({ name, ...body }),
    removeOnServer: (id) => mutations.deleteDesignerPage(id),
    local: {
      load: () => loadDesignerPages(scope, db, schema),
      save: (name, body) => saveDesignerPage(scope, { ...body, id: '', name, at: Date.now() }),
      remove: (name) => deleteDesignerPage(scope, db, schema, name),
    },
  })
  const entries = designerPagesFor(list.entries, db, schema)
  return (
    <NamedListPanel
      title={t.title}
      nameLabel={t.name}
      entries={entries.map((x) => ({ id: x.id, name: x.name, summary: t.summary(Object.keys(x.positions).length) }))}
      note={list.onServer ? locale.sql.savedOnServer : locale.sql.savedInBrowser}
      error={list.error}
      saveTitle={t.saveHint}
      canSave={Object.keys(positions).length > 0}
      onSave={(name) => list.save(name, { database: db, ...(schema ? { schema } : {}), positions, allColumns })}
      onLoad={(entry) => {
        const found = entries.find((x) => x.id === entry.id && x.name === entry.name)
        if (found) onLoad(found)
      }}
      loadLabel={t.load}
      deleteLabel={t.deleteLabel}
      onDelete={(entry) => list.remove(entry)}
      empty={t.empty}
    />
  )
}
