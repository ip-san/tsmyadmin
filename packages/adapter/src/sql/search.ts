/** What the database-wide search and the LIKE filters need to know about column types and user text. */
import type { Dialect } from '@tsmyadmin/shared'

/**
 * Column types the database-wide search skips, per dialect, matched on the type name as the catalog prints it.
 *
 * MySQL: binary strings, BIT and the spatial types store bytes, so their text form is raw WKB or binary and a
 * match would be noise (CAST to CHAR accepts them; it just compares bytes). GEOMETRYCOLLECTION is printed as
 * `geomcollection` since 8.0; VECTOR is binary too.
 * PostgreSQL: bytea (and arrays of it), and PostGIS geometry / geography / raster, whose text form is hex EWKB —
 * a short term like "01" would match every row. The built-in bit, point, polygon and the like have a readable
 * `::text` form ("1010", "(1.5,2)") that is worth searching.
 */
const UNSEARCHABLE_TYPE: Record<Dialect, RegExp> = {
  mysql:
    /^(tiny|medium|long)?blob\b|^(var)?binary\b|^bit\b|^vector\b|^(multi)?(point|linestring|polygon)\b|^geometry\b|^geometrycollection\b|^geomcollection\b/i,
  // PostGIS types may be schema-qualified: format_type adds the schema when it is not on the search path, which
  // is the usual case (PostGIS in public or its own schema, browsing another).
  // The whole name has to be the type (optionally with a typmod and array brackets), so a readable type that only
  // starts with one of these words, or sits in a schema named after one, is still searched.
  postgres: /^bytea(?:\[\])*$|(?:^|\.)"?(?:geometry|geography|raster)"?(?:\(.*\))?(?:\[\])*$/i,
}

/** Whether the database-wide search looks at a column of this type (see UNSEARCHABLE_TYPE). */
export function isSearchableType(dialect: Dialect, dataType: string): boolean {
  return !UNSEARCHABLE_TYPE[dialect].test(dataType)
}

/**
 * Escapes LIKE metacharacters so a user string matches literally. `!` is the escape character (declared with
 * ESCAPE '!'): unlike a backslash it needs no dialect-specific string escaping of its own.
 */
export function escapeLike(text: string): string {
  return text.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')
}
