#!/bin/bash
# PreToolUse hook — blocks destructive Bash commands that cannot be undone.
# Ships with AgentHive. Registered automatically for all agent worktrees.
#
# Exit 2 = blocking: Claude sees the stderr message and must ask the user.
# Exit 0 = allow: command proceeds normally.
#
# Guarded patterns:
#   git reset --hard   — discards uncommitted work
#   git push --force   — overwrites remote history
#   git push -f        — same, shorthand
#   git clean -f       — deletes untracked files
#   rm -rf             — recursive force delete
#   DROP TABLE         — destructive DDL
#   TRUNCATE           — destructive DDL

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -qiE '(git reset --hard|git push --force|git push -f[^i]|git clean -f|rm -rf|DROP TABLE|TRUNCATE)'; then
  MATCHED=$(echo "$COMMAND" | grep -oiE '(git reset --hard|git push --force|git push -f|git clean -f|rm -rf|DROP TABLE|TRUNCATE)' | head -1)
  echo "BLOCKED by AgentHive: '$MATCHED' is a destructive operation." >&2
  echo "If intentional, state the command, reason, and confirm." >&2
  exit 2
fi

exit 0
