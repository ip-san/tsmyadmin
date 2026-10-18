import type { ImportReason, LoginHintReason } from '@tsmyadmin/shared'
import type { Locale } from './ja.ts'

/**
 * The English strings first paint needs, key for key with `ja` (the `satisfies Locale` below fails the build when one
 * drifts). The screens' strings are in `screens-en.ts`.
 *
 * Conventions: sentence case for labels and buttons, an imperative verb for the primary action of a form
 * ("Import", "Run"); full sentences (hints, notices) end with a period, labels and error prefixes do not;
 * a table's fields are "columns", its records "rows", and counts of anything else are plain numbers.
 * Articles are dropped in labels, buttons and titles ("Clear history", not "Clear the history") and kept in
 * full sentences. Apostrophes are typographic (’); the straight one is only a JavaScript delimiter.
 */
export const en = {
  app: { name: 'tsmyadmin', tagline: 'MySQL / PostgreSQL admin' },
  shortcuts: {
    title: 'Keyboard shortcuts',
    open: 'Shortcuts',
    search: 'Focus the sidebar table filter',
    prevPage: 'Previous page',
    nextPage: 'Next page',
    runSql: 'Run SQL',
    toggleSidebar: 'Show / hide sidebar',
    editCell: 'Edit the focused cell (browse)',
    help: 'Show this list',
    home: 'Go to the server home',
    database: 'Go to the structure of this database',
    tableStructure: 'Go to the structure of this table',
    tableBrowse: 'Go to the rows of this table',
    sql: 'Go to the SQL tab of this level',
    export: 'Go to the export tab of this level',
    complete: 'Open completion in the SQL editor',
    editHint: 'Paging keys are inactive while an input has focus.',
  },
  session: {
    expiring: (minutes: number) => `Nothing has been done for a while: the session ends in about ${minutes} min.`,
    extend: 'Keep the session',
  },
  common: {
    loading: 'Loading…',
    error: 'Error',
    retry: 'Retry',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    close: 'Close',
    yes: 'Yes',
    no: 'No',
    null: 'NULL',
    empty: '(empty)',
    printList: 'Print this list',
    binary: (bytes: number) => `[binary, ${bytes.toLocaleString('en-US')} bytes]`,
    truncatedText: (length: number) => ` … (truncated, ${length.toLocaleString('en-US')} characters in total)`,
    bytes: (n: number) => {
      if (n < 1024) return `${n.toLocaleString('en-US')} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let v = n / 1024
      let i = 0
      // 1023.6 KB rounds to 1,024 KB: roll over to the next unit before it would print as 1024.
      while (v >= 1023.5 && i < units.length - 1) {
        v /= 1024
        i++
      }
      return `${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`
    },
    unknown: 'Unknown',
    theme: 'Toggle theme',
    language: 'Language',
    skipToContent: 'Skip to main content',
    reload: 'Reload',
    showMore: (n: number) => `Show all (${n.toLocaleString('en-US')} characters)`,
    showLess: 'Collapse',
    parenthesised: (s: string) => `(${s})`,
    showHead: (n: number) => `Show the first ${n.toLocaleString('en-US')} characters`,
    backHome: 'Back to the start page',
  },
  errorPage: {
    title: 'Something went wrong while rendering this page',
    body: 'If retrying the action does not help, reload the page.',
    notFoundTitle: 'Page not found',
    notFoundBody: 'The URL is wrong, or the database or table it names does not exist.',
  },
  login: {
    discovery: {
      title: 'When a database is missing or cannot be reached',
      unavailable:
        'Docker cannot be read. Mount the socket (`-v /var/run/docker.sock:/var/run/docker.sock`) and run as root (`user: "0:0"`).',
      none: 'No running MySQL / MariaDB / PostgreSQL container was found. Start the database, for example with `docker compose up -d`.',
      stopped: 'It is stopped. Start it and it shows up here.',
      notPublished:
        'It does not publish a port on the host, so it cannot be reached from here. Add this to your compose file.',
      starting: 'It is starting (not ready yet). It shows up on the list once it is ready.',
      unreachable: (host: string, port: number) =>
        `${host}:${port} cannot be reached. With Docker Engine on Linux, a port published on the host's 127.0.0.1 only may not be reachable from a container. Publish it on 0.0.0.0, or set TSMYADMIN_DOCKER_CONNECT_HOST to a name that reaches it.`,
    },
    connectionInfo: {
      title: 'Connection details for your application',
      intro:
        'Values to paste into the configuration of the application you are developing. No password is shown here: replace <password> with the one the container was given.',
      viewpoint: 'Where the application runs',
      host: 'On the host (outside Docker)',
      sameNetwork: (project: string) => `In a container of the same compose project (${project})`,
      sameNetworkNoProject: 'In a container on the same network',
      otherNetwork: 'In a container on another network',
      hostHint: 'Connects to the port published on the host.',
      sameNetworkHint:
        "Connects by the compose service name and the container's internal port (the host's port is not involved).",
      otherNetworkHint:
        'Goes through the port published on the host. With Docker Engine on Linux, the application container needs extra_hosts: ["host.docker.internal:host-gateway"].',
      address: 'Address',
      databaseUrl: 'DATABASE_URL',
      env: '.env (DATABASE_URL)',
      laravelEnv: '.env (Laravel)',
      copy: (what: string) => `Copy ${what}`,
      copyLabel: 'Copy',
      copied: 'Copied',
      copyFailed: 'Could not copy. Select the value shown and copy it',
    },
    presetGone: (name: string) => `${name} (no longer listed)`,
    presetGoneNotice: (name: string) =>
      `${name} has left the list (stopped, or restarting). When it is back you can connect as you are; you may also choose another server.`,
    presetsAdded: (names: string) => `Added to the servers: ${names}`,
    presetsRemoved: (names: string) => `Removed from the servers: ${names}`,
    dockerLogin:
      "Connects with the login in this container's environment (the user and password it was started with). Nothing to type.",
    advanced: 'Advanced',
    collation: 'Connection collation',
    collationHint:
      'The rules this connection uses to compare strings and convert character sets in SQL (MySQL / MariaDB).',
    collationDefault: '(default: utf8mb4_unicode_ci)',
    code: 'One-time code',
    codeHint: 'The six digits from your authenticator app, or a recovery code.',
    usePasskey: 'Use a passkey',
    passkeyFailed: 'The passkey check did not complete (it was cancelled, or no matching passkey was found)',
    title: 'Connect to a server',
    preset: 'Server',
    presetManual: 'Enter manually',
    presetHint:
      'A server your administrator configured. Enter your user name and password (on MySQL you may also change the database).',
    dialect: 'Server type',
    mysql: 'MySQL / MariaDB',
    postgres: 'PostgreSQL',
    host: 'Host',
    port: 'Port',
    user: 'Username',
    password: 'Password',
    database: 'Database',
    databaseHint: 'PostgreSQL needs a database to connect to (postgres when left empty).',
    submit: 'Connect',
    connecting: 'Connecting…',
    sessionExpired: 'Your session has expired. Connect again.',
    passwordChanged: 'Your password was changed. Connect with the new one.',
  },
  nav: {
    routines: 'Routines',
    events: 'Events',
    noPrograms: 'None',
    resizeSidebar: 'Sidebar width (the left and right arrow keys work too)',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    reloadTree: 'Reload the tree',
    showMore: (n: number) => `Show ${n.toLocaleString('en-US')} more`,
    groupOf: (name: string, n: number) => `${name} (${n.toLocaleString('en-US')})`,
    favoriteTables: 'Favorites',
    recentTables: 'Recent tables',
    favorite: 'Add to favorites',
    unfavorite: 'Remove from favorites',
    server: 'Server',
    databases: 'Databases',
    tables: 'Tables',
    logout: 'Disconnect',
    breadcrumb: 'Breadcrumb',
    help: 'Help',
    helpUrl: 'https://github.com/ip-san/tsmyadmin/blob/main/docs/en/user-guide.md',
    opensNewTab: ' (opens in a new tab)',
    expand: (name: string) => `Expand / collapse ${name}`,
    showSidebar: 'Show sidebar',
    hideSidebar: 'Hide sidebar',
    filterTables: 'Filter tables',
    noTables: 'No tables',
    matchCount: (shown: number, total: number) =>
      `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`,
    connectedAs: (user: string, host: string) => `${user}@${host}`,
    currentDatabase: 'Current database',
    tree: 'Database tree',
  },
  tabs: {
    security: 'Security',
    userGroups: 'User groups',
    tracking: 'Tracking',
    snapshots: 'Snapshots',
    databases: 'Databases',
    overview: 'Overview',
    structure: 'Structure',
    sql: 'SQL',
    search: 'Search',
    query: 'Query',
    designer: 'Designer',
    insert: 'Insert',
    browse: 'Browse',
    central: 'Central columns',
    operations: 'Operations',
    export: 'Export',
    import: 'Import',
    users: 'Users',
    privileges: 'Privileges',
    status: 'Status',
    variables: 'Variables',
    processes: 'Processes',
    advisor: 'Advisor',
    monitor: 'Monitor',
    routines: 'Routines',
    triggers: 'Triggers',
    events: 'Events',
  },
  reasons: {
    LOGIN_MYSQL_ACCESS_DENIED: (p: Record<string, string | number>) =>
      `Authentication failed (MySQL refused '${p.user}'@'${p.from}'). Either the password is wrong, or this account does not allow connections from ${p.from} (for example only 'root'@'localhost' exists, and a connection from a container comes from another address). Allow it with CREATE USER '${p.user}'@'%', or use an account that allows that address`,
    LOGIN_MYSQL_HOST_NOT_ALLOWED: (p: Record<string, string | number>) =>
      `MySQL does not allow connections from ${p.from} (no account allows that address). Create an account for 'user'@'%' or for '${p.from}'`,
    LOGIN_MYSQL_HOST_BLOCKED: (p: Record<string, string | number>) =>
      `MySQL has blocked ${p.from} after repeated connection errors. Run FLUSH HOSTS (or mysqladmin flush-hosts) on the server`,
    LOGIN_PG_NO_HBA_ENTRY: (p: Record<string, string | number>) =>
      `PostgreSQL's pg_hba.conf has no line letting ${p.from} in as user ${p.user}${p.database ? ` to database ${p.database}` : ''}. Add a host line to pg_hba.conf and reload the configuration (the official image allows every address by default)`,
    LOGIN_PG_PASSWORD: (p: Record<string, string | number>) =>
      `Authentication failed (PostgreSQL: the password of user ${p.user} is wrong, or that role does not exist). For a container, check the POSTGRES_USER / POSTGRES_PASSWORD it was first started with (changing them later has no effect)`,
    LOGIN_REFUSED: (p: Record<string, string | number>) =>
      `Nothing is listening on ${p.host}:${p.port}. Check that the database is running and that its port is published on the host${p.loopback ? '. If tsmyadmin runs in a container, localhost is that container itself (use host.docker.internal)' : ''}`,
    LOGIN_UNREACHABLE: (p: Record<string, string | number>) =>
      `${p.host}:${p.port} cannot be reached (timed out). Check the address, the port and any firewall`,
    LOGIN_HOST_UNKNOWN: (p: Record<string, string | number>) =>
      `The host name ${p.host} does not resolve. Check the spelling (a compose service name resolves only from containers on the same network)`,
    INVALID_ENCODING: (p: Record<string, string | number>) =>
      `The file holds bytes that are not valid UTF-8 (around line ${p.line ?? '?'}). Run mysqldump with --hex-blob and save text as UTF-8`,
    WRONG_DIALECT: (p: Record<string, string | number>) =>
      `This file is a ${p.dialect === 'postgres' ? 'PostgreSQL' : 'MySQL'} dump, which does not match the server you are connected to`,
    NO_STATEMENTS: () => 'No statements were found in the file',
    CSV_NO_TABLE: () => 'Choose the table to import the CSV into',
    CSV_EMPTY: () => 'The CSV file is empty',
    CSV_UNKNOWN_COLUMNS: (p: Record<string, string | number>) =>
      `The header names columns the table does not have: ${p.columns ?? ''}`,
    CSV_AMBIGUOUS_COLUMNS: (p: Record<string, string | number>) =>
      `A header name matches several columns differing only in case (spell it as the table does): ${p.columns ?? ''}`,
    CSV_DUPLICATE_COLUMNS: (p: Record<string, string | number>) =>
      `The header names the same column twice: ${p.columns ?? ''}`,
    CSV_NO_COLUMNS: () => 'No columns to import',
    CSV_FIELD_COUNT: (p: Record<string, string | number>) =>
      `Line ${p.line ?? '?'} has more fields (${p.fields ?? '?'}) than there are columns (${p.columns ?? '?'})`,
    CSV_BINARY: (p: Record<string, string | number>) =>
      `Line ${p.line ?? '?'}: column ${p.column ?? ''} is binary, so its value must be base64`,
    CSV_UNTERMINATED_QUOTE: (p: Record<string, string | number>) =>
      `The quote opened on line ${p.line ?? '?'} is never closed (everything after it would be one field, so the import stopped)`,
    CSV_ROW_FAILED: (p: Record<string, string | number>) =>
      `Line ${p.line ?? '?'} could not be imported (the whole file was rolled back): ${p.message ?? ''}`,
    OPTION_FAILED: (p: Record<string, string | number>) =>
      `The option "${p.option === 'ignoreForeignKeys' ? 'Disable foreign key checks' : 'Run in a single transaction'}" could not be applied (on PostgreSQL, disabling foreign key checks needs superuser rights): ${p.message ?? ''}`,
    UNTERMINATED_END: () =>
      'The file ends inside a comment or a string literal, so nothing could be committed in a single transaction. Close it, or turn that option off',
    IDENTIFIER_TOO_LONG: (p: Record<string, string | number>) =>
      `The name "${p.name ?? ''}" is too long (at most ${p.max ?? '?'} ${p.max === 63 ? 'bytes' : 'characters'})`,
    CSV_ROWS_FAILED: (p: Record<string, string | number>) =>
      `One of the lines ${p.from ?? '?'}–${p.to ?? '?'} could not be imported (the whole file was rolled back): ${p.message ?? ''}`,
    ARCHIVE_INVALID: (p: Record<string, string | number>) =>
      `The compressed file could not be opened: ${p.message ?? ''}`,
    ARCHIVE_TOO_LARGE: (p: Record<string, string | number>) => `The file unpacks to more than ${p.mb ?? '?'} MB`,
    ARCHIVE_MULTIPLE: () => 'The zip holds several files (only SQL files can be run together)',
    ROWS_NO_SHEET: (p: Record<string, string | number>) =>
      p.sheet ? `The file has no sheet or table named "${p.sheet}"` : 'The file holds no table to import',
    ROWS_PARSE: (p: Record<string, string | number>) => `The file could not be read: ${p.message ?? ''}`,
    TABLE_EXISTS: (p: Record<string, string | number>) =>
      `The table ${p.table ?? ''} exists already (give a new table another name)`,
    CREATE_INVALID_NAME: (p: Record<string, string | number>) =>
      `The table ${p.name ?? ''} could not be created (the table name or a column name in the file may not be usable): ${p.message ?? ''}`,
  } satisfies Record<ImportReason | LoginHintReason, (p: Record<string, string | number>) => string>,
  /** Prefixes: a server-side detail (DB message, validation issue) may follow after ": ", so no trailing period. */
  errors: {
    UNAUTHENTICATED: 'Your session has ended. Connect again',
    VALIDATION: 'Some of the input is not valid',
    CONNECTION_FAILED: 'The database server cannot be reached',
    AUTH_FAILED: 'Authentication failed',
    NOT_FOUND: 'The database, table or object was not found',
    QUERY_FAILED: 'The query failed',
    CONFLICT: 'Another change landed at the same time, so this one was not applied. Try again',
    KEY_MISMATCH:
      'The row could not be identified uniquely, so the change was rolled back (it may have been changed by someone else)',
    UNSUPPORTED: 'This operation is not supported',
    FORBIDDEN: 'This operation is not allowed',
    HOST_NOT_ALLOWED: 'Your administrator has not allowed connections to this server',
    INSECURE_TRANSPORT: 'Connect over HTTPS (a session cannot be kept over plain HTTP)',
    PERMISSION_DENIED: 'The database user lacks the privilege this operation needs',
    SECOND_FACTOR_REQUIRED: 'Enter your one-time code',
    SECOND_FACTOR_INVALID: 'That code is not valid (it may already have been used, or have expired)',
    RATE_LIMITED: 'Too many attempts. Wait a while and try again',
    PAYLOAD_TOO_LARGE: 'The request is too large',
    STORE_UNAVAILABLE: 'The server cannot use its session store right now. Try again in a moment',
    INTERNAL: 'Something went wrong on the server',
    NETWORK: 'The server cannot be reached. Check your network connection',
  },
} as const satisfies Locale
