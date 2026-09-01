import { MySQL, PostgreSQL, sql } from '@codemirror/lang-sql'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { Dialect } from '@tsmyadmin/shared'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'
import { locale } from '@/config/locale.ts'

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
        EditorView.contentAttributes.of({ 'aria-label': locale.sql.editor }),
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

  return (
    <div
      ref={host}
      className="min-h-40 rounded border border-zinc-300 bg-white text-sm dark:border-zinc-600 dark:bg-zinc-900"
    />
  )
}
