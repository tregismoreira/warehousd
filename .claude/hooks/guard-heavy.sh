#!/usr/bin/env bash
# PreToolUse/Bash adapter. The rule and its reasoning live in scripts/agent/guard-heavy.sh, which
# any agent or human can run directly; this file only translates between that script's exit code
# and Claude Code's hook protocol.
set -uo pipefail
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"

out="$("$ROOT/scripts/agent/guard-heavy.sh" "$cmd")" && exit 0

jq -nc --arg r "$out" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
