#!/usr/bin/env bash
# Shared process detection for the agent-hygiene scripts. Plain shell on purpose: no assistant,
# harness, or editor is required to run these. See AGENTS.md, "Machine load".
#
# Everything here is scoped deliberately. More than one working copy of this repo can exist on one
# machine, they all run the same command names, and docker-compose.test.yml binds a FIXED host port
# (54330) — so one Postgres serves whichever checkout started it. A cleanup that matched on command
# name alone would kill a sibling checkout's in-flight suite. Match on working directory instead.

# Test runners only. Dev servers are deliberately excluded: a `next dev` a human is driving is not
# residue, and is not something an agent should be blocked behind.
HEAVY_RE='vitest|playwright test|jest|phpunit|pytest'

# Processes that only *mention* a runner and must never be read as one:
#   - the MCP servers a harness parks and leaves idle; a stale playwright-mcp would otherwise look
#     like a live Playwright run and block every agent forever
#   - these scripts, which take the candidate command as an argument
# Matched on path rather than on the bare word `mcp`, which is what the first version of this file
# did: apps/web/test has five mcp-*.test.ts files, and a vitest worker running one of them carries
# "mcp" in its argv. Filtering that broadly made a live suite invisible to the guard.
IGNORE_RE='@playwright/mcp|playwright-mcp|mcp-server|scripts/agent/|\.claude/hooks/'

# This process and everything that spawned it. `pnpm agent:guard "vitest run x"` puts the word
# vitest into pnpm's own argv, so without this the guard reports itself as the running suite.
self_pids() {
  local pid=$$ ppid
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    printf '%s\n' "$pid"
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [ -z "$ppid" ] || [ "$ppid" = "$pid" ]; then break; fi
    pid="$ppid"
  done
}

# pids of running test runners, anywhere on this machine.
heavy_pids() {
  local skip
  skip="$(self_pids | tr '\n' '|')"
  pgrep -fl "$HEAVY_RE" 2>/dev/null \
    | grep -v -E "$IGNORE_RE" \
    | awk '{print $1}' \
    | grep -v -E "^(${skip%|})$"
}

# Working directory of a pid (macOS has no /proc).
cwd_of() {
  lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# pids of test runners whose cwd is inside $1 — i.e. started by this checkout.
heavy_pids_under() {
  local root="$1" pid cwd
  for pid in $(heavy_pids); do
    cwd="$(cwd_of "$pid")"
    case "$cwd" in "$root" | "$root"/*) echo "$pid" ;; esac
  done
}
