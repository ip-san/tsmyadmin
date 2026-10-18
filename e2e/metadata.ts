import type { Page } from '@playwright/test'
import { sqlOn, type Target } from './helpers.ts'

/** Two tables in `space`, one column commented (the owner): what the metadata search is tried on. */
export async function tablesWithComments(page: Page, space: Target) {
  await sqlOn(page, space, 'CREATE TABLE owners (id INT PRIMARY KEY, name VARCHAR(20))')
  if (space.dialect === 'mysql') {
    await sqlOn(page, space, "CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT COMMENT 'かいぬし')")
  } else {
    await sqlOn(page, space, 'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT)')
    await sqlOn(page, space, "COMMENT ON COLUMN pets.owner_id IS 'かいぬし'")
  }
}
