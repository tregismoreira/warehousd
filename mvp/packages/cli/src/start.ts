import { Pool } from "pg";
import { resolve } from "node:path";
import {
  assertDocker,
  ensureImage,
  ensureNetwork,
  ensureVolume,
  containerState,
  removeContainer,
  runContainer,
  logs,
} from "./docker";
import { resolveProject, type Project } from "./project";
import { ensureState, writeOutputs, type Outputs } from "./state";
import { buildOutputs, formatOutputs } from "./outputs";
import { getDevClient } from "@warehousd/broker";
import { dataRoleUrl } from "@warehousd/broker";

const DEFAULT_IMAGE = "ghcr.io/warehousd/warehousd:dev";
const HEALTH_CHECK_TIMEOUT_MS = 180_000;
const HEALTH_CHECK_INTERVAL_MS = 1000;

async function pollHealth(url: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  const interval = HEALTH_CHECK_INTERVAL_MS;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Not ready yet, keep trying
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Health check timeout after ${timeoutMs}ms`);
}

export async function runStart(
  dir: string,
  opts: { seed?: number; pull?: boolean; verbose?: boolean } = {}
): Promise<Outputs> {
  // Step 1: Assert Docker is available
  assertDocker();

  // Step 2: Resolve project config
  const p = resolveProject(dir);
  const st = ensureState(p.dir);

  // Step 3: Ensure images exist
  const serverImage = p.cfg.server.image ?? DEFAULT_IMAGE;
  ensureImage(serverImage);
  if (p.managed) {
    ensureImage("pgvector/pgvector:pg16");
  }

  // Step 4: Ensure network
  ensureNetwork(p.ns.net, p.ns.label);

  // Step 5: Ensure database (if managed)
  if (p.managed) {
    ensureVolume(p.ns.volume, p.ns.label);
    const dbState = containerState(p.ns.db);
    if (dbState !== "running") {
      removeContainer(p.ns.db);
      runContainer({
        name: p.ns.db,
        image: "pgvector/pgvector:pg16",
        network: p.ns.net,
        label: p.ns.label,
        env: {
          POSTGRES_USER: "warehousd",
          POSTGRES_PASSWORD: st.dbPassword,
          POSTGRES_DB: "warehousd",
        },
        ports: {
          [`127.0.0.1:${p.ports.db}`]: "5432",
        },
        volumes: {
          "/var/lib/postgresql/data": p.ns.volume,
        },
      });
    }
  }

  // Step 6: Compute database URLs
  let appUrlHost: string;
  let appUrlContainer: string;

  if (p.managed) {
    appUrlHost = `postgres://warehousd:${st.dbPassword}@localhost:${p.ports.db}/warehousd`;
    appUrlContainer = `postgres://warehousd:${st.dbPassword}@${p.ns.db}:5432/warehousd`;
  } else {
    appUrlHost = p.cfg.database.url!;
    appUrlContainer = appUrlHost;
  }

  // Step 7: Recreate server container
  const adminEmail = "admin@warehousd.local";
  removeContainer(p.ns.server);
  runContainer({
    name: p.ns.server,
    image: serverImage,
    network: p.ns.net,
    label: p.ns.label,
    env: {
      APP_DATABASE_URL: appUrlContainer,
      WAREHOUSD_DATA_ROLE_PASSWORD: st.dataRolePassword,
      WAREHOUSD_PROJECT_DIR: "/project",
      BETTER_AUTH_SECRET: st.betterAuthSecret,
      BETTER_AUTH_URL: `http://localhost:${p.ports.server}`,
      WAREHOUSD_ADMIN_EMAIL: adminEmail,
      WAREHOUSD_ADMIN_PASSWORD: st.adminPassword,
      WAREHOUSD_DEMO: String(p.cfg.demo ?? false),
      WAREHOUSD_SEED: String(opts.seed ?? 42),
    },
    ports: {
      [`127.0.0.1:${p.ports.server}`]: "8722",
    },
    volumes: {
      "/project": p.dir,
    },
  });

  // Step 8: Poll health endpoint
  const appUrl = `http://localhost:${p.ports.server}`;
  try {
    await pollHealth(appUrl, HEALTH_CHECK_TIMEOUT_MS);
  } catch (err) {
    const containerLogs = logs(p.ns.server, 50);
    throw new Error(
      `Container health check failed: ${String(err)}\n\nContainer logs:\n${containerLogs}`
    );
  }

  // Step 9: Connect and get dev client
  const db = new Pool({ connectionString: appUrlHost });
  try {
    const devClient = await getDevClient(db);
    if (!devClient) {
      const containerLogs = logs(p.ns.server, 50);
      throw new Error(
        `Failed to retrieve dev client. Container logs:\n${containerLogs}`
      );
    }

    // Step 10: Build and write outputs
    const outputs = buildOutputs(p, appUrlHost, devClient);
    writeOutputs(p.dir, outputs);

    return outputs;
  } finally {
    await db.end();
  }
}
