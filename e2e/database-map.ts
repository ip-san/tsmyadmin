import type { Page } from '@playwright/test'
import { sqlOn, type Target } from './helpers.ts'

/**
 * Three tables in `space`, one of each kind the map lists: owners (a master), pets (a detail, its key to owners
 * with no index of its own on PostgreSQL) and logs (no primary key, joined to nothing).
 */
export async function petsAndLogs(page: Page, space: Target) {
  await sqlOn(page, space, 'CREATE TABLE owners (id INT PRIMARY KEY, name VARCHAR(20))')
  await sqlOn(
    page,
    space,
    'CREATE TABLE pets (id INT PRIMARY KEY, owner_id INT, FOREIGN KEY (owner_id) REFERENCES owners (id))'
  )
  await sqlOn(page, space, 'CREATE TABLE logs (message VARCHAR(20))')
}
