import { useRouteContext } from '@tanstack/react-router'
import type { ExportTemplate, ExportTemplateBody } from '@tsmyadmin/shared'
import { NamedListPanel } from '@/components/panels/NamedListPanel.tsx'
import { locale } from '@/config/locale.ts'
import { exportTemplatesQuery, listExportTemplates, mutations } from '@/lib/queries.ts'
import { useNamedList } from '@/lib/use-named-list.ts'
import { deleteTemplate, loadTemplates, saveTemplate, templatesFor } from './export-templates.ts'

const t = locale.export.templates

/** What a template stores, in one line: the format and how many tables (or the whole database). */
function summary(template: ExportTemplateBody): string {
  const tables = template.tables.length === 0 ? t.wholeDatabase : t.tableCount(template.tables.length)
  const parts = [template.options.format.toUpperCase(), tables]
  if (!template.options.structure) parts.push(t.dataOnly)
  if (!template.options.data) parts.push(t.structureOnly)
  return parts.join(' · ')
}

/**
 * Saved export choices for this database: save what the form currently shows under a name, and put it back
 * later. Kept with the account where the deployment can (as bookmarks are), otherwise in this browser.
 */
export function ExportTemplatesPanel({
  db,
  schema,
  current,
  canSave,
  onLoad,
}: {
  db: string
  schema?: string | undefined
  /** The form as it stands, saved when a name is given. */
  current: ExportTemplateBody
  canSave: boolean
  onLoad: (template: ExportTemplate) => void
}) {
  const { session } = useRouteContext({ from: '/_app' })
  const scope = `${session.dialect}.${session.host}.${session.port}`
  const list = useNamedList<ExportTemplate, ExportTemplateBody>({
    onServer: session.savedQueries === 'server',
    query: { queryKey: exportTemplatesQuery.queryKey, queryFn: listExportTemplates },
    saveOnServer: (name, body) => mutations.saveExportTemplate({ name, ...body }),
    removeOnServer: (id) => mutations.deleteExportTemplate(id),
    local: {
      load: () => loadTemplates(scope),
      save: (name, body) => saveTemplate(scope, { ...body, id: '', name, at: Date.now() }),
      remove: (name) => deleteTemplate(scope, name),
    },
  })
  const entries = templatesFor(list.entries, db, schema)
  return (
    <NamedListPanel
      title={t.title}
      nameLabel={t.name}
      entries={entries.map((template) => ({ id: template.id, name: template.name, summary: summary(template) }))}
      note={list.onServer ? locale.sql.savedOnServer : locale.sql.savedInBrowser}
      error={list.error}
      saveTitle={t.saveHint}
      canSave={canSave}
      onSave={(name) => list.save(name, current)}
      onLoad={(entry) => {
        const template = entries.find((x) => x.id === entry.id && x.name === entry.name)
        if (template) onLoad(template)
      }}
      loadLabel={locale.sql.load}
      deleteLabel={t.deleteLabel}
      onDelete={(entry) => list.remove(entry.name)}
      empty={t.empty}
    />
  )
}
