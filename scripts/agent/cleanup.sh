#!/usr/bin/env bash
# Leave the machine as we found it: stop what this checkout started, reclaim the databases it left
# on the shared Postgres, and — only if the machine is otherwise quiet — stop the containers.
#
#   scripts/agent/cleanup.sh
#
# Meant to run when work stops, including when it stopped badly. That is the point: the residue
# that actually accumulates is not left by an agent choosing carelessly, it is left by a process
# dying. No instruction can clean up after SIGKILL; this can. An interrupted run leaks one database
# per suite, and this sweep is what reclaims them.
#
# Scoping, in order of danger:
#   processes  killed only if their cwd is inside THIS checkout. Sibling checkouts run the same
#              command names; matching on name alone would kill their suite.
#   our databases   every test database this checkout creates ends in the checkout suffix (SUFFIX
#              in packages/broker/test/helpers/templates.ts, via runDbName). Step 1 has just
#              killed every runner under this root, so anything still carrying our suffix is a
#              corpse — droppable regardless of what other checkouts are doing.
#   any databases   the untagged `wh_%` strays that predate the suffix could belong to anyone, so
#              they wait for the machine to go quiet.
#   containers stopped last, same condition, and never with `-v` — that would take the volume and
#              with it the cached template databases, costing the next run a full rebuild.
set -uo pipefail
ROOT="${WAREHOUSD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "$ROOT/scripts/agent/lib.sh"
cd "$ROOT" || exit 0

# Must match SUFFIX in packages/broker/test/helpers/templates.ts, which hashes the repo root as a
# file URL pathname — hence the trailing slash. If the two ever drift, this sweep simply matches
# nothing and the quiet-machine sweep below still catches everything, so drift costs latency
# rather than correctness.
SUFFIX="$(printf '%s/' "$ROOT" | shasum -a 256 | cut -c1-8)"

report=""

# 1. Processes this checkout started.
mine="$(heavy_pids_under "$ROOT" | tr '\n' ' ')"
if [ -n "${mine// /}" ]; then
  kill $mine 2>/dev/null
  sleep 2
  for p in $mine; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
  report="${report}killed test processes: ${mine% }; "
fi

# The Postgres serving 54330 belongs to whichever checkout ran `test:up` first, so it is not
# necessarily in this directory's compose project — ask by published port rather than by project,
# or a sibling-started server leaves this sweep looking at nothing.
db="$(docker ps --filter publish=54330 --format '{{.ID}}' 2>/dev/null | head -1)"

# Drop a `wh_%` set and report how many. $1 is a psql WHERE fragment over pg_database.
# Templates (wh_tmpl_*) are kept deliberately: they are what makes the next `pnpm test` skip the
# bootstrap. DROP DATABASE cannot run inside a DO block, hence \gexec.
sweep() {
  local where="$1" label="$2" n
  n="$(docker exec "$db" psql -U postgres -tAc \
    "select count(*) from pg_database where $where" 2>/dev/null | tr -d ' ')"
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null || return 0
  docker exec -i "$db" psql -U postgres -q >/dev/null 2>&1 <<SQL
select format('drop database if exists %I with (force)', datname)
from pg_database where $where
\gexec
SQL
  report="${report}dropped ${n} ${label}; "
}

BASE_WHERE="datname like 'wh\\_%' and datname not like '%tmpl%' and not datistemplate"

# 2. Ours by name. No quiet needed — step 1 killed everything that could still be using these.
[ -n "$db" ] && sweep "$BASE_WHERE and datname like '%\\_${SUFFIX}'" "stale test databases"

# 3 and 4 need the machine quiet. A sibling mid-run must not lose its databases or its server.
others="$(heavy_pids | tr '\n' ' ')"
if [ -n "${others// /}" ]; then
  echo "${report}left the containers and other checkouts' databases alone — another suite is running (pids: ${others% })"
  exit 0
fi

# 3. Whatever is left is unattributable, and now provably abandoned.
[ -n "$db" ] && sweep "$BASE_WHERE" "unattributed test databases"

# 4. Only this checkout's own containers, which is what `compose stop` scopes to by project.
if docker compose -f docker-compose.test.yml ps -q 2>/dev/null | grep -q .; then
  docker compose -f docker-compose.test.yml stop >/dev/null 2>&1 && report="${report}stopped test containers; "
fi

[ -z "$report" ] && report="nothing to clean"
echo "${report%; }"
