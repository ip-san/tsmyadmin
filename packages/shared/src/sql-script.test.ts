import { describe, expect, it } from 'vitest'
import { sqlScript } from './sql-script.ts'

describe('sqlScript', () => {
  it('joins plain statements with semicolons', () => {
    expect(sqlScript('mysql', ['CREATE TABLE a (id INT)', 'CREATE TABLE b (id INT)'])).toBe(
      'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT)'
    )
    expect(sqlScript('postgres', ['CREATE FUNCTION f() AS $body$ SELECT 1; $body$'])).toBe(
      'CREATE FUNCTION f() AS $body$ SELECT 1; $body$'
    )
  })

  it('switches the MySQL delimiter when a body holds semicolons of its own, to one no statement contains', () => {
    expect(sqlScript('mysql', ['CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN SET @x = 1; END'])).toBe(
      'DELIMITER $$\nCREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN SET @x = 1; END\n$$\nDELIMITER ;'
    )
    expect(sqlScript('mysql', ["CREATE PROCEDURE p() BEGIN SELECT '$$'; END"])).toMatch(/^DELIMITER \/\/\n/)
  })
})
