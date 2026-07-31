import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@warehousd/broker";
import {
  dockerVersion,
  imageExists,
  containerOnPort,
  containerState,
  psByLabel,
  type ContainerRow,
} from "./docker";
import { resolveProject } from "./project";
import { resolveServerImage } from "./image-resolve";
import type { Check } from "./ui/render";

// Checks that run *before* anything is created, and the whole of `warehousd doctor`.
//
// The incident that motivated this: a first `start` failed because the server image resolved to a
// registry tag that could not be pulled, while `warehousd:dev` — built moments earlier — sat in the
// local image store unused. The CLI never said which image it wanted or where the name came from.
// `imageCheck` now says both, before a single container is created.
//
// Shares the `{ id, ok, detail }` shape with deploy's preflight (packages/cli/src/deploy/preflight.ts)
// so one renderer draws both (renderChecks in ui/render.ts).

/** A free port answers the question a `docker ps` scan cannot: a stray local Postgres counts too. */
export async function portIsFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

export function dockerCheck(): Check {
  try {
    const version = dockerVersion();
    return { id: "docker", ok: true, detail: `daemon reachable, server ${version}` };
  } catch {
    return {
      id: "docker",
      ok: false,
      detail: "daemon not reachable — start Docker Desktop (or `colima start`) and retry",
    };
  }
}

export function configCheck(dir: string): Check {
  if (!existsSync(join(dir, "warehousd.yml"))) {
    return { id: "config", ok: false, detail: "no warehousd.yml here — run `warehousd init`" };
  }
  try {
    const cfg = loadConfig(dir);
    const n = Object.keys(cfg.collections).length;
    return { id: "config", ok: true, detail: `warehousd.yml parses, ${n} collection(s)` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: "config", ok: false, detail: msg.split("\n")[0] ?? msg };
  }
}

/**
 * The check the reported incident needed. Names the image, says which of the three sources chose
 * it, and whether it is already local — so "could not pull" is never the first time a user hears
 * which tag was wanted.
 */
export function imageCheck(dir: string, env: NodeJS.ProcessEnv = process.env): Check {
  let resolved;
  try {
    resolved = resolveServerImage(dir, env);
  } catch (err: unknown) {
    return { id: "image", ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const local = imageExists(resolved.ref);
  if (local) {
    return {
      id: "image",
      ok: true,
      detail: `${resolved.ref} (${resolved.source}, present locally)`,
    };
  }
  return {
    id: "image",
    ok: true,
    detail: `${resolved.ref} (${resolved.source}, not local — will be pulled)`,
  };
}

export async function portCheck(dir: string): Promise<Check[]> {
  const p = resolveProject(dir);
  const checks: Check[] = [];
  for (const [label, port, owner] of [
    ["port:server", p.ports.server, p.ns.server],
    ["port:db", p.ports.db, p.ns.db],
  ] as const) {
    if (!p.managed && label === "port:db") continue;
    const free = await portIsFree(port);
    if (free) {
      checks.push({ id: label, ok: true, detail: `${port} is free` });
      continue;
    }
    const holder = containerOnPort(port);
    if (holder === owner) {
      checks.push({ id: label, ok: true, detail: `${port} held by this project's ${holder}` });
    } else if (holder) {
      checks.push({
        id: label,
        ok: false,
        detail: `${port} is held by container ${holder} — stop it, or change the port in warehousd.yml`,
      });
    } else {
      checks.push({
        id: label,
        ok: false,
        detail: `${port} is in use by something that is not a container — change the port in warehousd.yml`,
      });
    }
  }
  return checks;
}

export function containersCheck(dir: string): { check: Check; rows: ContainerRow[] } {
  const p = resolveProject(dir);
  const rows = psByLabel(p.ns.label);
  if (rows.length === 0) {
    return {
      check: { id: "containers", ok: false, detail: "none — run `warehousd start`" },
      rows,
    };
  }
  const server = containerState(p.ns.server);
  return {
    check: {
      id: "containers",
      ok: server === "running",
      detail:
        server === "running"
          ? `${rows.length} container(s), server running`
          : `server is ${server} — `.concat("`warehousd logs` shows why"),
    },
    rows,
  };
}

export type DoctorResult = { ok: boolean; checks: Check[] };

export async function runDoctor(dir: string): Promise<DoctorResult> {
  const checks: Check[] = [dockerCheck()];

  const cfg = configCheck(dir);
  checks.push(cfg);

  // Everything after this reads warehousd.yml, so a broken config would only produce noise.
  if (cfg.ok && checks[0]?.ok) {
    checks.push(imageCheck(dir));
    checks.push(...(await portCheck(dir)));
    checks.push(containersCheck(dir).check);
  }

  return { ok: checks.every((c) => c.ok), checks };
}
