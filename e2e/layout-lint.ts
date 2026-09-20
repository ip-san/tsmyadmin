import type { Page } from '@playwright/test'

/**
 * Geometry checks over the rendered page — what type checking, lint and axe cannot see:
 * - a dropdown whose arrow sits on its text (the right padding lost to another utility);
 * - fields side by side whose controls do not start at the same height (a hint pushing one up);
 * - a button beside a field that is not level with the field's control;
 * - two controls drawn on top of each other;
 * - the page scrolling sideways (naming the element that sticks out);
 * - a button, label or cell whose text is cut off or spills out of its box;
 * - a checkbox beside labelled fields that is not level with their controls (it drifts up to the label row);
 * - the page itself taller than the window inside the app shell (an absolutely placed element stretching it, so the
 *   page scrolls past the end of the content);
 * - the same id used twice (a `<label for>` then points at the wrong control);
 * - placeholders that leaked into the text (`undefined`, `NaN`, `[object Object]`, `Invalid Date`).
 * Runs in the page, so it costs one evaluate per screen. Each finding is one line naming the element.
 */
export async function layoutViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      // Also false inside a closed <details> and under `content-visibility: hidden`.
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    }
    // Not covered by something else (a dialog's backdrop): only what the user can actually see is judged.
    const exposed = (el: Element): boolean => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return hit !== null && (el === hit || el.contains(hit) || hit.contains(el))
    }
    const name = (el: Element): string => {
      const label = el.getAttribute('aria-label') ?? el.id ?? ''
      const text = (el.textContent ?? '').trim().slice(0, 24)
      return `<${el.tagName.toLowerCase()}${label ? ` "${label}"` : text ? ` "${text}"` : ''}>`
    }

    for (const sel of document.querySelectorAll('select')) {
      if (!visible(sel)) continue
      const s = getComputedStyle(sel)
      if (s.backgroundImage !== 'none' && Number.parseFloat(s.paddingRight) < 28) {
        out.push(`dropdown arrow overlaps its text: ${name(sel)} has padding-right ${s.paddingRight}`)
      }
    }

    const controlOf = (box: Element): Element | null => box.querySelector('input:not([type=hidden]), select, textarea')
    // Fields (a label above a control) in one flex row: their controls must start at the same height.
    for (const row of document.querySelectorAll('div, form, section')) {
      if (getComputedStyle(row).display !== 'flex' || !visible(row)) continue
      const kids = [...row.children].filter((k) => visible(k) && exposed(k))
      const isField = (k: Element) => k.querySelector(':scope > label[for]') !== null && controlOf(k) !== null
      // Wrapped rows are judged line by line: the children that overlap vertically share a line.
      const lines: Element[][] = []
      let reach = Number.NEGATIVE_INFINITY
      for (const k of [...kids].sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top)) {
        const r = k.getBoundingClientRect()
        const line = lines[lines.length - 1]
        if (line && r.top < reach - 1) {
          line.push(k)
          reach = Math.max(reach, r.bottom)
        } else {
          lines.push([k])
          reach = r.bottom
        }
      }
      for (const line of lines) {
        const fields = line.filter(isField)
        const first = fields[0]
        if (!first) continue
        // Fields side by side: their controls must start at the same height.
        const tops = fields.map((f) => (controlOf(f) as Element).getBoundingClientRect().top)
        if (fields.length > 1 && Math.max(...tops) - Math.min(...tops) > 2) {
          out.push(`fields in a row are not level: ${fields.map((f) => name(controlOf(f) as Element)).join(', ')}`)
        }
        const anchor = (controlOf(first) as Element).getBoundingClientRect()
        const middle = anchor.top + anchor.height / 2
        for (const k of line) {
          if (fields.includes(k)) continue
          const r = k.getBoundingClientRect()
          if (k.tagName === 'BUTTON') {
            // A button beside a field: level with the field's control.
            if (Math.abs(r.top + r.height / 2 - middle) > 4) {
              out.push(`button is not level with the field beside it: ${name(k)}`)
            }
            continue
          }
          // A checkbox with no label field of its own: centred on the controls beside it.
          const box = k.querySelector('input[type=checkbox], input[type=radio]')
          if (!box || k.querySelector('legend, select, input:not([type=checkbox]):not([type=radio]), textarea'))
            continue
          const c = box.getBoundingClientRect()
          if (Math.abs(c.top + c.height / 2 - middle) > 8) {
            out.push(`checkbox is not level with the fields beside it: ${name(k)}`)
          }
        }
      }
    }

    const controls = [
      ...document.querySelectorAll('input:not([type=hidden]), select, textarea, button, a[href]'),
    ].filter((c) => visible(c) && exposed(c) && getComputedStyle(c).position !== 'fixed')
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i] as Element
        const b = controls[j] as Element
        if (a.contains(b) || b.contains(a)) continue
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
        if (w > 2 && h > 2) out.push(`controls overlap: ${name(a)} and ${name(b)}`)
      }
    }

    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth + 1) {
      const inScroller = (el: Element): boolean => {
        for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX
          if (o === 'auto' || o === 'scroll' || o === 'hidden') return true
        }
        return false
      }
      const sticking = [...document.body.querySelectorAll('*')]
        .filter((el) => visible(el) && el.getBoundingClientRect().right > root.clientWidth + 1 && !inScroller(el))
        .slice(0, 3)
        .map(name)
      out.push(
        `page scrolls sideways: ${root.scrollWidth}px of content in ${root.clientWidth}px${sticking.length ? `, sticking out: ${sticking.join(', ')}` : ''}`
      )
    }

    // In the app shell the panes scroll, never the page: a taller document means something escaped its pane.
    if (document.querySelector('aside[data-scroll-root]') && root.scrollHeight > root.clientHeight + 1) {
      const escaped = [...document.body.querySelectorAll('*')]
        .filter(
          (el) =>
            el.getBoundingClientRect().bottom > root.clientHeight + 1 && getComputedStyle(el).position === 'absolute'
        )
        .slice(0, 3)
        .map(name)
      out.push(
        `page is taller than the window in the app shell: ${root.scrollHeight}px in ${root.clientHeight}px${escaped.length ? `, escaping: ${escaped.join(', ')}` : ''}`
      )
    }

    // Text wider than its box: cut off (overflow hidden without an ellipsis) or spilling over its neighbour.
    for (const el of document.querySelectorAll('button, label, th, td, option, summary')) {
      if (!visible(el) || el.tagName === 'OPTION') continue
      const s = getComputedStyle(el)
      if (s.display === 'inline' || el.scrollWidth <= el.clientWidth + 1) continue
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue
      if (s.textOverflow === 'ellipsis' && s.overflowX === 'hidden') continue
      out.push(`text does not fit its box: ${name(el)} (${el.scrollWidth}px in ${el.clientWidth}px)`)
    }

    const seen = new Map<string, Element>()
    for (const el of document.querySelectorAll('[id]')) {
      const prev = seen.get(el.id)
      if (prev) out.push(`id used twice: "${el.id}" on ${name(prev)} and ${name(el)}`)
      else seen.set(el.id, el)
    }

    const leaked = /\b(undefined|NaN|Invalid Date)\b|\[object Object\]/.exec(document.body.innerText)
    if (leaked) out.push(`a placeholder leaked into the page text: "${leaked[0]}"`)
    return out
  })
}
