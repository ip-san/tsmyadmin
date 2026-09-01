#!/bin/bash
# PreToolUse hook: block destructive Bash commands. Reads tool input JSON from stdin.
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

case "$CMD" in
  *'rm -rf'*)
    echo "BLOCK: rm -rf detected. Use targeted rm instead." >&2; exit 2 ;;
  *'git reset --hard'*)
    echo "BLOCK: git reset --hard. Use git stash or checkout specific files." >&2; exit 2 ;;
  *'git clean -f'*)
    echo "BLOCK: git clean -f. Review untracked files first with git status." >&2; exit 2 ;;
  *'git push --force'*|*'git push -f '*)
    echo "BLOCK: force push." >&2; exit 2 ;;
  *'git checkout -- .'*|*'git restore .'*)
    echo "BLOCK: would discard all changes. Use specific file paths." >&2; exit 2 ;;
esac

# Destructive SQL rules apply only when the command actually invokes a DB client — source files may
# legitimately contain these phrases (DDL builders, tests, docs) or paths like src/mysql/.
# "Invokes a client" ≈ lowercase mysql/psql as a word, not part of a path/identifier, followed by whitespace.
if echo "$CMD" | grep -qE "(^|[^/[:alnum:]_.-])(mysql|psql)[[:space:]]"; then
  # DROP DATABASE via a client is never OK from a shell command; use bun run db:reset for the test DBs.
  if echo "$CMD" | grep -qiE 'drop[[:space:]]+database'; then
    echo "BLOCK: DROP DATABASE via a DB client. Recreate test DBs with 'bun run db:reset' instead." >&2; exit 2
  fi
  # DROP TABLE / TRUNCATE are fine against the compose test DBs (fixtures are recreated by db:reset)
  # but must never be pointed at another host.
  if echo "$CMD" | grep -qiE '\b(drop[[:space:]]+table|truncate)\b'; then
    if ! echo "$CMD" | grep -qE '127\.0\.0\.1|localhost|docker compose'; then
      echo "BLOCK: destructive SQL against a non-local host." >&2; exit 2
    fi
  fi
fi
exit 0
