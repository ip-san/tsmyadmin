/**
 * Catalog predicates about the sequence behind a column, shared by the table listing (which hides such a
 * sequence), describeTable (which marks the column `serial`) and the DDL reconstruction (which reads its options).
 * Written once so the three views of "this sequence belongs to that column" cannot drift apart.
 */

/** `DEFAULT nextval('<seq>'::regclass)` and nothing else (a `+ 1000` or `::text` around it is a plain default). */
const PLAIN_NEXTVAL = String.raw`'^nextval\(''(?:[^'']|'''')*''::regclass\)$'`

/**
 * The column (`rel`, `att`) has a DEFAULT that depends on the sequence `seq` — every argument is a SQL expression
 * naming an oid / attnum in the enclosing query. `plain` additionally requires the default to be a bare nextval().
 */
function pgDefaultUsesSequence(seq: string, rel: string, att: string, plain: boolean): string {
  return `EXISTS (SELECT 1 FROM pg_attrdef ad
                  JOIN pg_depend dd ON dd.classid = 'pg_attrdef'::regclass AND dd.objid = ad.oid
                                    AND dd.refclassid = 'pg_class'::regclass AND dd.refobjid = ${seq}
                  WHERE ad.adrelid = ${rel} AND ad.adnum = ${att}${plain ? ` AND pg_get_expr(ad.adbin, ad.adrelid) ~ ${PLAIN_NEXTVAL}` : ''})`
}

/** The sequence is OWNED BY the column (the auto dependency CREATE TABLE … serial / ALTER SEQUENCE OWNED BY make). */
function pgOwnedBy(seq: string, rel: string, att: string): string {
  return `EXISTS (SELECT 1 FROM pg_depend od
                  WHERE od.objid = ${seq} AND od.classid = 'pg_class'::regclass AND od.refclassid = 'pg_class'::regclass
                    AND od.refobjid = ${rel} AND od.refobjsubid = ${att} AND od.deptype = 'a')`
}

/** Named `<table>_<column>_seq`, as CREATE TABLE names a serial column's sequence. */
function pgSerialName(seqRelname: string, tableRelname: string, attname: string): string {
  return `${seqRelname} = ${tableRelname} || '_' || ${attname} || '_seq'`
}

/**
 * Composed predicates, each bound to the aliases of the query it lives in (this file is an SQL builder, so the
 * introspection queries only splice these constants).
 */

/** Listing (`c` = the sequence): it belongs to an identity column, or is the serial sequence of column `a` of table `t`. */
export const SEQUENCE_BEHIND_COLUMN = `
  SELECT 1 FROM pg_depend d
  JOIN pg_class t ON t.oid = d.refobjid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
  WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
    AND (d.deptype = 'i' OR (d.deptype = 'a' AND ${pgSerialName('c.relname', 't.relname', 'a.attname')}
         AND ${pgDefaultUsesSequence('c.oid', 't.oid', 'a.attnum', true)}))`

/** describeTable (`a` = the column): a serial sequence of its own exists. */
export const COLUMN_HAS_SERIAL_SEQUENCE = `EXISTS (SELECT 1 FROM pg_class c
  WHERE c.relkind = 'S' AND ${pgOwnedBy('c.oid', 'a.attrelid', 'a.attnum')}
    AND ${pgSerialName('c.relname', '(SELECT relname FROM pg_class WHERE oid = a.attrelid)', 'a.attname')}
    AND ${pgDefaultUsesSequence('c.oid', 'a.attrelid', 'a.attnum', true)})`

/** Sequence options (`a` = the column, `d` = its dependency, `s` = the sequence): the identity's own, or the serial default's. */
export const OPTIONS_SEQUENCE_OF_COLUMN = `((a.attidentity <> '' AND d.deptype = 'i')
  OR (a.attidentity = '' AND d.deptype = 'a' AND ${pgDefaultUsesSequence('s.seqrelid', 'a.attrelid', 'a.attnum', false)}))`
