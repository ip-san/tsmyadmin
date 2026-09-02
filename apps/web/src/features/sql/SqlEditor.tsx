import { MySQL, PostgreSQL, sql } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { Dialect } from '@tsmyadmin/shared'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'
import { locale } from '@/config/locale.ts'
import { useTheme } from '@/lib/theme.ts'

/** Dark palette (zinc surfaces, the same accent hues as the light default) — basicSetup only ships the light one. */
const darkHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: '#c084fc' },
  { tag: [tags.string, tags.special(tags.string)], color: '#86efac' },
  { tag: [tags.number, tags.bool, tags.null], color: '#fdba74' },
  { tag: tags.comment, color: '#a1a1aa', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: '#7dd3fc' },
  { tag: tags.operator, color: '#e4e4e7' },
  { tag: tags.punctuation, color: '#d4d4d8' },
])
const darkTheme = EditorView.theme(
  {
    '&': { color: '#f4f4f5', backgroundColor: '#18181b' },
    '.cm-content': { caretColor: '#f4f4f5' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#f4f4f5' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
      backgroundColor: '#3f3f46',
    },
    '.cm-activeLine': { backgroundColor: '#27272a' },
    '.cm-gutters': { backgroundColor: '#18181b', color: '#a1a1aa', borderRight: '1px solid #3f3f46' },
    '.cm-activeLineGutter': { backgroundColor: '#27272a' },
    '.cm-tooltip': { backgroundColor: '#27272a', color: '#f4f4f5', border: '1px solid #3f3f46' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#3f3f46', color: '#f4f4f5' },
    '.cm-matchingBracket': { backgroundColor: '#3f3f46', outline: '1px solid #71717a' },
  },
  { dark: true }
)
const themeExtension = (theme: 'light' | 'dark'): Extension =>
  theme === 'dark' ? [darkTheme, syntaxHighlighting(darkHighlight)] : []

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  onRun: () => void
  dialect: Dialect
  /** Table → column names, used for completion. */
  schema: Record<string, string[]>
}

/** CodeMirror 6 SQL editor. The view is created once; value/schema updates are dispatched into it. */
export function SqlEditor({ value, onChange, onRun, dialect, schema }: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const [theme] = useTheme()
  const latest = useRef({ onChange, onRun })
  latest.current = { onChange, onRun }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; later prop changes are synced by the effects below
  useEffect(() => {
    const el = host.current
    if (!el) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        langCompartment.current.of(sql({ dialect: dialect === 'mysql' ? MySQL : PostgreSQL, schema })),
        themeCompartment.current.of(themeExtension(theme)),
        // Highest precedence: basicSetup binds Mod-Enter to insertBlankLine.
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                latest.current.onRun()
                return true
              },
            },
          ])
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString())
        }),
        // tabindex on the content: axe does not count contenteditable as focusable, so a horizontally scrolling
        // editor would be reported as an unreachable scroll region.
        EditorView.contentAttributes.of({ 'aria-label': locale.sql.editor, tabindex: '0' }),
      ],
    })
    const v = new EditorView({ state, parent: el })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: langCompartment.current.reconfigure(sql({ dialect: dialect === 'mysql' ? MySQL : PostgreSQL, schema })),
    })
  }, [dialect, schema])

  useEffect(() => {
    view.current?.dispatch({ effects: themeCompartment.current.reconfigure(themeExtension(theme)) })
  }, [theme])

  return (
    <div
      ref={host}
      className="min-h-40 rounded border border-zinc-300 bg-white text-sm dark:border-zinc-600 dark:bg-zinc-900"
    />
  )
}
