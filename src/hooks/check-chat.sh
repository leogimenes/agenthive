#!/bin/bash
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
MESSAGES=$(grep -v '^\s*#' "$CHAT_FILE" | sed '/^\s*$/d')

[ -n "$MESSAGES" ] || exit 0

MSG="[HIVE COORDINATION] Active messages in chat:

${MESSAGES}

Before proceeding: check for do-not-touch notices and in-progress work.
After significant changes: append a [ROLE] TYPE: message to the chat file."

case "$EVENT" in
  "UserPromptSubmit")
    jq -n --arg ctx "$MSG" \
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":$ctx}}'
    ;;
  "PostToolUse")
    jq -n --arg ctx "$MSG" \
      '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
    ;;
  *)
    exit 0
    ;;
esac

exit 0
