import type { ApiErrorCode, ImportReason, LoginHintReason } from '@tsmyadmin/shared'

/**
 * The Japanese strings first paint needs (the login page, the error page, the tabs and the error messages), and the
 * shape every other locale must have (`Locale`). The strings of the screens behind the login are in `screens-ja.ts`,
 * loaded with the first of them. Components must reference `locale.*`, never a literal in either language.
 *
 * Conventions: primary submit / confirm buttons use the verb form（〜する）, secondary actions and labels use
 * 体言止め; full sentences (hints, notices) end with 。, labels and error prefixes do not; table columns are
 * 「カラム」, table rows are counted in 「行」, tables / matches in 「件」; 「データベース」 is spelled out except in
 * narrow table headers; DROP / DELETE is 「削除」, non-destructive resets are 「クリア」.
 */
export const ja = {
  app: { name: 'tsmyadmin', tagline: 'MySQL / PostgreSQL 管理ツール' },
  shortcuts: {
    title: 'キーボードショートカット',
    open: 'ショートカット一覧',
    search: 'サイドバーのテーブル絞り込みへ',
    prevPage: '前のページ',
    nextPage: '次のページ',
    runSql: 'SQL を実行',
    toggleSidebar: 'サイドバーの表示 / 非表示',
    editCell: 'フォーカス中のセルを編集（一覧）',
    help: 'この一覧を表示',
    home: 'サーバーのホームへ',
    database: '今のデータベースの構造へ',
    tableStructure: '今のテーブルの構造へ',
    tableBrowse: '今のテーブルの表示へ',
    sql: '今の階層の SQL タブへ',
    export: '今の階層のエクスポートへ',
    complete: 'SQL エディターで補完を開く',
    editHint: '入力欄にフォーカスがある間、ページ移動キーは無効です。',
  },
  session: {
    expiring: (minutes: number) => `操作がないため、約 ${minutes} 分でセッションが切れます。`,
    extend: 'セッションを延長',
  },
  common: {
    loading: '読み込み中…',
    error: 'エラー',
    retry: '再試行',
    cancel: 'キャンセル',
    save: '保存する',
    delete: '削除',
    close: '閉じる',
    yes: 'はい',
    no: 'いいえ',
    null: 'NULL',
    empty: '（空）',
    printList: '一覧を印刷',
    binary: (bytes: number) => `[バイナリ ${bytes.toLocaleString('ja-JP')} バイト]`,
    truncatedText: (length: number) => `（全 ${length.toLocaleString('ja-JP')} 文字のうち先頭のみ表示）`,
    bytes: (n: number) => {
      if (n < 1024) return `${n.toLocaleString('ja-JP')} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let v = n / 1024
      let i = 0
      // 1023.6 KB rounds to 1,024 KB: roll over to the next unit before it would print as 1024.
      while (v >= 1023.5 && i < units.length - 1) {
        v /= 1024
        i++
      }
      return `${v.toLocaleString('ja-JP', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`
    },
    unknown: '不明',
    theme: 'テーマ切替',
    language: '表示言語',
    skipToContent: 'メインコンテンツへ移動',
    reload: '再読み込み',
    showMore: (n: number) => `全文を表示（${n.toLocaleString('ja-JP')} 文字）`,
    showLess: '折りたたむ',
    parenthesised: (s: string) => `（${s}）`,
    showHead: (n: number) => `先頭 ${n.toLocaleString('ja-JP')} 文字を表示`,
    backHome: 'トップへ戻る',
  },
  errorPage: {
    title: '画面の表示中にエラーが発生しました',
    body: '操作をやり直しても解決しない場合は、再読み込みしてください。',
    notFoundTitle: 'ページが見つかりません',
    notFoundBody: 'URL が間違っているか、対象のデータベースやテーブルが存在しません。',
  },
  login: {
    discovery: {
      title: '接続先が見つからない・つながらないとき',
      unavailable:
        'Docker を読めません。ソケットをマウントし（`-v /var/run/docker.sock:/var/run/docker.sock`）、root で動かして（`user: "0:0"`）ください。',
      none: '起動している MySQL / MariaDB / PostgreSQL のコンテナが見つかりません。`docker compose up -d` などで DB を起動してください。',
      stopped: '停止しています。起動すると、ここに出ます。',
      notPublished: 'ホストにポートを公開していないので、ここからは届きません。compose に次を足してください。',
      starting: '起動中（まだ準備ができていません）。準備ができると、接続先に出ます。',
      unreachable: (host: string, port: number) =>
        `${host}:${port} に届きません。Linux の Docker Engine で、ホストの 127.0.0.1 だけに公開したポートは、コンテナからは届かないことがあります。0.0.0.0 で公開するか、TSMYADMIN_DOCKER_CONNECT_HOST を届く名前にしてください。`,
    },
    connectionInfo: {
      title: 'アプリからつなぐときの接続情報',
      intro:
        '開発中のアプリの設定に貼る値です。パスワードはここには出しません。<password> を、コンテナに渡したパスワードに置き換えてください。',
      viewpoint: 'アプリが動いている場所',
      host: 'ホスト（docker の外）',
      sameNetwork: (project: string) => `同じ compose のコンテナ（${project}）`,
      sameNetworkNoProject: '同じネットワークのコンテナ',
      otherNetwork: '別のネットワークのコンテナ',
      hostHint: 'ホストに公開したポートにつなぎます。',
      sameNetworkHint: 'compose のサービス名と、コンテナの中のポートでつなぎます（ホストのポートは通りません）。',
      otherNetworkHint:
        'ホストに公開したポートを経由します。Linux の Docker Engine では、アプリのコンテナに extra_hosts: ["host.docker.internal:host-gateway"] が要ります。',
      address: 'アドレス',
      databaseUrl: 'DATABASE_URL',
      env: '.env（DATABASE_URL）',
      laravelEnv: '.env（Laravel）',
      copy: (what: string) => `${what} をコピー`,
      copyLabel: 'コピー',
      copied: 'コピーしました',
      copyFailed: 'コピーできませんでした。表示されている値を選んでコピーしてください',
    },
    presetGone: (name: string) => `${name}（一覧にありません）`,
    presetGoneNotice: (name: string) =>
      `${name} が一覧から消えました（停止したか、起動し直しています）。戻ると、このまま接続できます。別の接続先を選ぶこともできます。`,
    presetsAdded: (names: string) => `接続先に追加されました: ${names}`,
    presetsRemoved: (names: string) => `接続先から消えました: ${names}`,
    dockerLogin:
      'このコンテナの環境変数にある資格情報（起動時に渡されたユーザーとパスワード）で接続します。入力は要りません。',
    advanced: '詳細設定',
    collation: '接続の照合順序',
    collationHint: 'この接続が SQL の文字列を比べたり、文字コードを変換したりするときの規則です（MySQL / MariaDB）。',
    collationDefault: '（既定: utf8mb4_unicode_ci）',
    code: 'ワンタイムコード',
    codeHint: '認証アプリの 6 桁、または回復用コードを入力してください。',
    usePasskey: 'パスキーで確認',
    passkeyFailed: 'パスキーでの確認を完了できませんでした（取り消した場合や、対応するパスキーがない場合を含みます）',
    title: 'サーバーに接続',
    preset: '接続先',
    presetManual: '手動で入力',
    presetHint:
      '管理者が用意した接続先です。ユーザー名とパスワードを入力してください（MySQL ではデータベース名を変えることもできます）。',
    dialect: 'サーバー種別',
    mysql: 'MySQL / MariaDB',
    postgres: 'PostgreSQL',
    host: 'ホスト',
    port: 'ポート',
    user: 'ユーザー名',
    password: 'パスワード',
    database: 'データベース',
    databaseHint: 'PostgreSQL は接続先データベースが必要です（省略時は postgres）。',
    submit: '接続する',
    connecting: '接続中…',
    sessionExpired: 'セッションの有効期限が切れました。もう一度接続してください。',
    passwordChanged: 'パスワードを変更しました。新しいパスワードで接続してください。',
  },
  nav: {
    routines: 'ルーチン',
    events: 'イベント',
    noPrograms: 'なし',
    resizeSidebar: 'サイドバーの幅（左右の矢印キーでも変えられます）',
    expandAll: 'すべて展開',
    collapseAll: 'すべて折りたたむ',
    reloadTree: 'ツリーを再読み込み',
    showMore: (n: number) => `さらに ${n.toLocaleString('ja-JP')} 件を表示`,
    groupOf: (name: string, n: number) => `${name}（${n.toLocaleString('ja-JP')}）`,
    favoriteTables: 'お気に入り',
    recentTables: '最近使ったテーブル',
    favorite: 'お気に入りに追加',
    unfavorite: 'お気に入りから外す',
    server: 'サーバー',
    databases: 'データベース',
    tables: 'テーブル',
    logout: '切断',
    breadcrumb: '現在の場所',
    help: 'ヘルプ',
    /** 利用者向けマニュアル。配布先が自前のものに差し替えることを想定しています。 */
    helpUrl: 'https://github.com/ip-san/tsmyadmin/blob/main/docs/user-guide.md',
    opensNewTab: '（新しいタブで開く）',
    expand: (name: string) => `${name} を展開 / 折りたたむ`,
    showSidebar: 'サイドバーを表示',
    hideSidebar: 'サイドバーを隠す',
    filterTables: 'テーブルを絞り込む',
    noTables: 'テーブルがありません',
    matchCount: (shown: number, total: number) =>
      `${total.toLocaleString('ja-JP')} 件中 ${shown.toLocaleString('ja-JP')} 件`,
    connectedAs: (user: string, host: string) => `${user}@${host}`,
    currentDatabase: '対象データベース',
    tree: 'データベースツリー',
  },
  tabs: {
    security: 'セキュリティ',
    userGroups: 'ユーザーグループ',
    tracking: '追跡',
    snapshots: 'スナップショット',
    databases: 'データベース',
    overview: '概要',
    structure: '構造',
    sql: 'SQL',
    search: '検索',
    query: 'クエリ',
    designer: 'デザイナ',
    insert: '挿入',
    browse: '表示',
    central: 'セントラルカラム',
    operations: '操作',
    export: 'エクスポート',
    import: 'インポート',
    users: 'ユーザー',
    privileges: '権限',
    status: 'ステータス',
    variables: '変数',
    processes: 'プロセス',
    advisor: 'アドバイザー',
    monitor: 'モニター',
    routines: 'ルーチン',
    triggers: 'トリガー',
    events: 'イベント',
  },
  reasons: {
    LOGIN_MYSQL_ACCESS_DENIED: (p: Record<string, string | number>) =>
      `認証に失敗しました（MySQL: '${p.user}'@'${p.from}' を拒否）。パスワードが違うか、このアカウントが ${p.from} からの接続を許していません（'root'@'localhost' だけがあり、コンテナからの接続が別のアドレスになる場合など）。CREATE USER '${p.user}'@'%' で許すか、そのアドレスからの接続を許可したアカウントを使ってください`,
    LOGIN_MYSQL_HOST_NOT_ALLOWED: (p: Record<string, string | number>) =>
      `MySQL が ${p.from} からの接続を許していません（このアドレスを許すアカウントがありません）。'ユーザー'@'%' か '${p.from}' 用のアカウントを作ってください`,
    LOGIN_MYSQL_HOST_BLOCKED: (p: Record<string, string | number>) =>
      `MySQL が、接続エラーが続いた ${p.from} を締め出しています。サーバーで FLUSH HOSTS（または mysqladmin flush-hosts）を実行してください`,
    LOGIN_PG_NO_HBA_ENTRY: (p: Record<string, string | number>) =>
      `PostgreSQL の pg_hba.conf に、${p.from} からユーザー ${p.user}${p.database ? `・データベース ${p.database}` : ''} で入る行がありません。pg_hba.conf に host 行を足して設定を再読み込みしてください（公式イメージは既定ですべてのアドレスを許します）`,
    LOGIN_PG_PASSWORD: (p: Record<string, string | number>) =>
      `認証に失敗しました（PostgreSQL: ユーザー ${p.user} のパスワードが違うか、そのロールがありません）。コンテナなら、起動時の POSTGRES_USER / POSTGRES_PASSWORD を確かめてください（初回起動後に変えても反映されません）`,
    LOGIN_REFUSED: (p: Record<string, string | number>) =>
      `${p.host}:${p.port} で待ち受けているサーバーがありません。DB が起動しているか、ポートをホストに公開しているかを確かめてください${p.loopback ? '。tsmyadmin をコンテナで動かしているなら、localhost はそのコンテナ自身です（host.docker.internal を使ってください）' : ''}`,
    LOGIN_UNREACHABLE: (p: Record<string, string | number>) =>
      `${p.host}:${p.port} に届きません（時間切れ）。アドレスとポート、ファイアウォールを確かめてください`,
    LOGIN_HOST_UNKNOWN: (p: Record<string, string | number>) =>
      `ホスト名 ${p.host} を引けません。綴りを確かめてください（compose のサービス名は、同じネットワークのコンテナからしか引けません）`,
    INVALID_ENCODING: (p: Record<string, string | number>) =>
      `ファイルに UTF-8 として不正なバイトが含まれています（${p.line ?? '?'} 行目付近）。mysqldump は --hex-blob を付けて出力し、テキストは UTF-8 で保存してください`,
    WRONG_DIALECT: (p: Record<string, string | number>) =>
      `この SQL は ${p.dialect === 'postgres' ? 'PostgreSQL' : 'MySQL'} 用のダンプです（接続先の種別と一致しません）`,
    NO_STATEMENTS: () => '実行する文が見つかりませんでした',
    CSV_NO_TABLE: () => 'CSV の取り込み先テーブルを選択してください',
    CSV_EMPTY: () => 'CSV ファイルが空です',
    CSV_UNKNOWN_COLUMNS: (p: Record<string, string | number>) =>
      `ヘッダーにテーブルにないカラムがあります: ${p.columns ?? ''}`,
    CSV_AMBIGUOUS_COLUMNS: (p: Record<string, string | number>) =>
      `ヘッダーのカラム名が大文字小文字だけ異なる複数のカラムに一致します（テーブルどおりの表記にしてください）: ${p.columns ?? ''}`,
    CSV_DUPLICATE_COLUMNS: (p: Record<string, string | number>) =>
      `ヘッダーに同じカラムが 2 回あります: ${p.columns ?? ''}`,
    CSV_NO_COLUMNS: () => '取り込むカラムがありません',
    CSV_FIELD_COUNT: (p: Record<string, string | number>) =>
      `${p.line ?? '?'} 行目のフィールド数（${p.fields ?? '?'}）がカラム数（${p.columns ?? '?'}）を超えています`,
    CSV_BINARY: (p: Record<string, string | number>) =>
      `${p.line ?? '?'} 行目: カラム ${p.column ?? ''} はバイナリのため base64 で指定してください`,
    CSV_UNTERMINATED_QUOTE: (p: Record<string, string | number>) =>
      `${p.line ?? '?'} 行目で開いた引用符が閉じていません（以降の行が 1 つのフィールドになるため取り込みを中止しました）`,
    CSV_ROW_FAILED: (p: Record<string, string | number>) =>
      `${p.line ?? '?'} 行目の取り込みに失敗しました（ファイル全体を取り消しました）: ${p.message ?? ''}`,
    OPTION_FAILED: (p: Record<string, string | number>) =>
      `オプション「${p.option === 'ignoreForeignKeys' ? '外部キー制約のチェックを無効にする' : '1 つのトランザクションで実行する'}」を適用できませんでした（PostgreSQL では外部キー検査の無効化にスーパーユーザー権限が必要です）: ${p.message ?? ''}`,
    UNTERMINATED_END: () =>
      'ファイルの末尾がコメントまたは文字列の途中で終わっています（1 つのトランザクションで実行するとコミットできないため中止しました）。末尾を閉じるか、このオプションを外してください',
    IDENTIFIER_TOO_LONG: (p: Record<string, string | number>) =>
      `名前「${p.name ?? ''}」が長すぎます（最大 ${p.max ?? '?'} ${p.max === 63 ? 'バイト' : '文字'}）`,
    CSV_ROWS_FAILED: (p: Record<string, string | number>) =>
      `${p.from ?? '?'}〜${p.to ?? '?'} 行目のいずれかの取り込みに失敗しました（ファイル全体を取り消しました）: ${p.message ?? ''}`,
    ARCHIVE_INVALID: (p: Record<string, string | number>) => `圧縮ファイルを開けませんでした: ${p.message ?? ''}`,
    ARCHIVE_TOO_LARGE: (p: Record<string, string | number>) =>
      `展開すると ${p.mb ?? '?'} MB を超えるため取り込めません`,
    ARCHIVE_MULTIPLE: () => 'zip に複数のファイルがあります（複数を一度に取り込めるのは SQL ファイルだけです）',
    ROWS_NO_SHEET: (p: Record<string, string | number>) =>
      p.sheet ? `「${p.sheet}」というシート / 表がファイルにありません` : 'ファイルに取り込める表がありません',
    ROWS_PARSE: (p: Record<string, string | number>) => `ファイルを読めませんでした: ${p.message ?? ''}`,
    TABLE_EXISTS: (p: Record<string, string | number>) =>
      `テーブル ${p.table ?? ''} はすでにあります（新しく作る場合は別の名前にしてください）`,
    CREATE_INVALID_NAME: (p: Record<string, string | number>) =>
      `テーブル ${p.name ?? ''} を作れませんでした（テーブル名またはファイルのカラム名が使えない可能性があります）: ${p.message ?? ''}`,
  } satisfies Record<ImportReason | LoginHintReason, (p: Record<string, string | number>) => string>,
  /** Prefixes: a server-side detail (DB message, validation issue) may follow after 「: 」, so no trailing 。. */
  errors: {
    UNAUTHENTICATED: '接続が切れています。もう一度接続してください',
    VALIDATION: '入力内容に誤りがあります',
    CONNECTION_FAILED: 'サーバーに接続できません',
    AUTH_FAILED: '認証に失敗しました',
    NOT_FOUND: '対象のデータベース・テーブル・オブジェクトが見つかりません',
    QUERY_FAILED: 'クエリの実行に失敗しました',
    KEY_MISMATCH: '対象行を一意に特定できませんでした（変更は取り消されました）',
    CONFLICT: 'ほかの操作と同時になり、反映できませんでした。もう一度お試しください',
    UNSUPPORTED: 'この操作はサポートされていません',
    FORBIDDEN: '許可されていない操作です',
    HOST_NOT_ALLOWED: 'この接続先は管理者により許可されていません',
    INSECURE_TRANSPORT: 'HTTPS で接続してください（HTTP ではログイン状態を保持できません）',
    PERMISSION_DENIED: 'この操作に必要な権限がデータベースユーザーにありません',
    SECOND_FACTOR_REQUIRED: 'ワンタイムコードを入力してください',
    SECOND_FACTOR_INVALID: 'コードが正しくありません（使用済み・期限切れを含みます）',
    RATE_LIMITED: '試行回数が多すぎます。しばらく待ってから再度お試しください',
    PAYLOAD_TOO_LARGE: '送信データが大きすぎます',
    STORE_UNAVAILABLE: 'サーバーのセッション保存先がいま使えません。しばらくしてからもう一度お試しください',
    INTERNAL: '内部エラーが発生しました',
    NETWORK: 'サーバーと通信できません。ネットワーク接続を確認してください',
  } satisfies Record<ApiErrorCode | 'NETWORK', string>,
} as const

/**
 * The set of strings a locale must provide: the Japanese one with its literal types widened, so another language
 * has to match every key and every function signature, but of course not the Japanese text itself.
 */
export type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : { [K in keyof T]: Widen<T[K]> }
export type Locale = Widen<typeof ja>
