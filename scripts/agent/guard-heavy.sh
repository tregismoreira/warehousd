#!/usr/bin/env bash
# Refuse to start a second test suite while one is already running anywhere on this machine.
#
#   scripts/agent/guard-heavy.sh "<the command you are about to run>"
#   exit 0  clear, nothing printed
#   exit 1  a suite is live; the report is on stdout
#
# This is the one rule in AGENTS.md that cannot be expressed as an instruction. Each working copy
# gets its own agent and none of them can see the others, so "check what is running first" is
# advice every agent can follow correctly while the machine still ends up with four concurrent
# suites. A machine-wide check is the only thing that can actually serialise them.
#
# Deliberately not a lockfile: a lock has to be released, and the case that matters most is the run
# that died without releasing anything. Looking for live processes is self-healing — if the process
# is gone, the check passes.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cmd="${1-}"

# Container lifecycle is not a suite. `pnpm test:up` contains "pnpm test" as a substring, and
# blocking it would leave a checkout unable to start or stop its own Postgres while a sibling runs.
case "$cmd" in
  *test:up* | *test:down*) exit 0 ;;
esac

# Only guard commands that actually start a suite. Builds and installs are heavy too, but they are
# not the thing that pins eight cores for a minute, and blocking them would make the guard hated.
case "$cmd" in
  *vitest* | *"pnpm test"* | *"pnpm e2e"* | *"npm test"* | *playwright* | *jest* | *pytest* | *phpunit*) ;;
  *) exit 0 ;;
esac

pids="$(heavy_pids | tr '\n' ' ')"
[ -z "${pids// /}" ] && exit 0

echo "A test suite is already running on this machine — probably a sibling checkout of this repo."
for p in $pids; do echo "  pid $p  cwd=$(cwd_of "$p")"; done
echo "Running a second one now overloads the CPU for both. Wait for it to finish and retry, or ask."
echo "Do not work around this by renaming the command."
exit 1
