import type { Page } from '@playwright/test'
import { scratchName, sqlOn, type Target } from './helpers.ts'

/** A parent and a child whose key names two parents that are not there (the key was added unchecked). */
export async function orphanedKey(page: Page, t: Target) {
  const parent = scratchName('e2e_orph')
  const child = `${parent}_c`
  const drop = async () => {
    await sqlOn(page, t, `DROP TABLE IF EXISTS ${child}`)
    await sqlOn(page, t, `DROP TABLE IF EXISTS ${parent}`)
  }
  try {
    await sqlOn(page, t, `CREATE TABLE ${parent} (id INT PRIMARY KEY)`)
    await sqlOn(page, t, `CREATE TABLE ${child} (id INT PRIMARY KEY, pid INT)`)
    await sqlOn(page, t, `INSERT INTO ${parent} VALUES (1)`)
    await sqlOn(page, t, `INSERT INTO ${child} VALUES (1, 1), (2, 7), (3, 8), (4, NULL)`)
    await sqlOn(
      page,
      t,
      t.dialect === 'mysql'
        ? `SET FOREIGN_KEY_CHECKS = 0; ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id)`
        : `ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (pid) REFERENCES ${parent} (id) NOT VALID`
    )
  } catch (err) {
    await drop()
    throw err
  }
  return { key: `${child}_fk`, drop }
}
