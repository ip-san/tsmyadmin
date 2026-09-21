import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { layoutViolations } from './layout-lint.ts'

/** What is wrong with the page as it is: axe's WCAG 2.0 – 2.2 A / AA violations, then the layout checks. */
export async function pageProblems(page: Page): Promise<{ axe: unknown[]; layout: string[] }> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  return { axe: results.violations, layout: await layoutViolations(page) }
}
