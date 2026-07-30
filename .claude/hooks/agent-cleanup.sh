#!/usr/bin/env bash
# SessionEnd adapter. The cleanup and its reasoning live in scripts/agent/cleanup.sh, which any
# agent or human can run directly; this file only surfaces its report to the session.
#
# SessionEnd fires on /clear and on a crash as well as on a clean exit, which is the point — the
# residue worth reclaiming is the residue left by a process that died.
set -uo pipefail
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

report="$(WAREHOUSD_ROOT="$ROOT" "$ROOT/scripts/agent/cleanup.sh" 2>/dev/null)"

jq -nc --arg r "$report" '{systemMessage: ("[cleanup] " + $r)}'
