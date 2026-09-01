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
  *'DROP DATABASE'*|*'drop database'*)
    echo "BLOCK: DROP DATABASE. Recreate test DBs with 'bun run db:reset' instead." >&2; exit 2 ;;
esac

# DROP TABLE / TRUNCATE are fine against the compose test DBs (fixtures are recreated by db:reset)
# but must never be pointed at another host from a shell command.
if echo "$CMD" | grep -qiE '\b(drop table|truncate)\b' && echo "$CMD" | grep -qE '\b(mysql|psql)\b'; then
  if ! echo "$CMD" | grep -qE '127\.0\.0\.1|localhost|docker compose'; then
    echo "BLOCK: destructive SQL against a non-local host." >&2; exit 2
  fi
fi
exit 0
