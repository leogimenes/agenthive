// Embedded hook scripts — bundled as string constants so they ship with any
// distribution format (tsc, Bun compile, npm package).
//
// If you edit the .sh files, regenerate this module or update the strings below.

export const EMBEDDED_HOOKS: Record<string, string> = {
  'destructive-guard': `#!/bin/bash
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
`,

  'check-chat': `#!/bin/bash
# Hook — Surfaces shared agent coordination messages from the hive chat file.
# Ships with AgentHive. Registered for UserPromptSubmit and PostToolUse(git commit).
#
# Reads the chat file location from $HIVE_CHAT_FILE environment variable.
# Falls back to .hive/chat.md relative to the git root if unset.

# Determine chat file path
if [ -n "$HIVE_CHAT_FILE" ]; then
  CHAT_FILE="$HIVE_CHAT_FILE"
else
  GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  if [ -n "$GIT_ROOT" ]; then
    CHAT_FILE="$GIT_ROOT/.hive/chat.md"
  else
    exit 0  # Not in a git repo — nothing to surface
  fi
fi

# Read hook input to determine event type
INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null || echo "")

# Nothing to surface if file is absent or empty
[ -f "$CHAT_FILE" ] && [ -s "$CHAT_FILE" ] || exit 0

# Extract only actual messages — skip comment/header lines and blank lines
MESSAGES=$(grep -v '^\\s*#' "$CHAT_FILE" | sed '/^\\s*$/d')

[ -n "$MESSAGES" ] || exit 0

MSG="[HIVE COORDINATION] Active messages in chat:

\${MESSAGES}

Before proceeding: check for do-not-touch notices and in-progress work.
After significant changes: append a [ROLE] TYPE: message to the chat file."

case "$EVENT" in
  "UserPromptSubmit")
    jq -n --arg ctx "$MSG" \\
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
    ;;
  "PostToolUse")
    jq -n --arg ctx "$MSG" \\
      '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
    ;;
  *)
    exit 0
    ;;
esac

exit 0
`,
};
