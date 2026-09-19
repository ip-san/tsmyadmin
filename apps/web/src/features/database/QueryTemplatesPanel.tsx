import { useRouteContext } from '@tanstack/react-router'
import {
  type QueryBuilderRequestInput,
  QueryBuilderRequestSchema,
  type QueryTemplate,
  type QueryTemplateBody,
} from '@tsmyadmin/shared'
import { NamedListPanel } from '@/components/panels/NamedListPanel.tsx'
import { locale } from '@/config/locale.ts'
import { listQueryTemplates, mutations, queryTemplatesQuery } from '@/lib/queries.ts'
import { useNamedList } from '@/lib/use-named-list.ts'
import { deleteQueryTemplate, loadQueryTemplates, queryTemplatesFor, saveQueryTemplate } from './query-templates.ts'

const t = locale.queryBuilder.templates

/**
 * Query-builder setups kept under a name for this database: save the form as it stands, put one back later.
 * Kept with the account where the deployment can (as bookmarks are), otherwise in this browser.
 */
export function QueryTemplatesPanel({
  db,
  schema,
  current,
  onLoad,
}: {
  db: string
  schema: string | undefined
  current: QueryBuilderRequestInput
  onLoad: (template: QueryTemplate) => void
}) {
  const { session } = useRouteContext({ from: '/_app' })
  const scope = `${session.dialect}.${session.host}.${session.port}`
  const list = useNamedList<QueryTemplate, QueryTemplateBody>({
    onServer: session.savedQueries === 'server',
    query: { queryKey: queryTemplatesQuery.queryKey, queryFn: listQueryTemplates },
    saveOnServer: (name, body) => mutations.saveQueryTemplate({ name, ...body }),
    removeOnServer: (id) => mutations.deleteQueryTemplate(id),
    local: {
      load: () => loadQueryTemplates(scope, db, schema),
      save: (name, body) => saveQueryTemplate(scope, { ...body, id: '', name, at: Date.now() }),
      remove: (name) => deleteQueryTemplate(scope, db, schema, name),
    },
  })
  const entries = queryTemplatesFor(list.entries, db, schema)
  const { schema: _schema, ...request } = current
  // Through the schema: its defaults filled in, and nothing saved that the builder would refuse.
  const parsed = QueryBuilderRequestSchema.omit({ schema: true }).safeParse(request)
  return (
    <NamedListPanel
      title={t.title}
      nameLabel={t.name}
      entries={entries.map((x) => ({ id: x.id, name: x.name, summary: x.request.tables.join(', ') }))}
      note={list.onServer ? locale.sql.savedOnServer : locale.sql.savedInBrowser}
      error={list.error}
      saveTitle={t.saveHint}
      canSave={parsed.success}
      onSave={(name) => {
        if (parsed.success)
          list.save(name, {
            database: db,
            ...(schema ? { schema } : {}),
            request: parsed.data,
          } satisfies QueryTemplateBody)
      }}
      onLoad={(entry) => {
        const found = entries.find((x) => x.id === entry.id && x.name === entry.name)
        if (found) onLoad(found)
      }}
      loadLabel={locale.sql.load}
      deleteLabel={t.deleteLabel}
      onDelete={(entry) => list.remove(entry)}
      empty={t.empty}
    />
  )
}
