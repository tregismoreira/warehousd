import { Pool } from "pg";
import {
  assertDocker,
  dockerVersion,
  ensureImage,
  ensureNetwork,
  ensureVolume,
  imageExists,
  containerState,
  containerOnPort,
  removeContainer,
  runContainer,
  logs,
} from "./docker";
import { resolveProject } from "./project";
import { ensureState, writeOutputs, type Outputs } from "./state";
import { buildOutputs } from "./outputs";
import { resolveServerImage } from "./image-resolve";
import { portIsFree } from "./preflight";
import { silentReporter, type Reporter } from "./ui/reporter";
import { getDevClient } from "@warehousd/broker";

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
  opts: { seed?: number; pull?: boolean; verbose?: boolean; reporter?: Reporter } = {},
): Promise<Outputs> {
  const report = opts.reporter ?? silentReporter;

  // Step 1: Assert Docker is available
  assertDocker();

  // Step 2: Resolve project config
  const p = resolveProject(dir);
  const st = ensureState(p.dir);

  const check = report.step("Checking", `${p.name}`);
  check.done(`docker ${dockerVersion()}`);

  // Step 3: Ensure images exist.
  //
  // Preflight before anything is created. A first run in examples/harbor once failed here with a
  // registry error that never named the tag it wanted, while a locally built image sat unused —
  // so say which image, and which of the three sources chose it, before trying to fetch it.
  const image = resolveServerImage(p.dir, process.env);
  const serverImage = image.ref;

  // A port already taken is worth knowing before `docker run` turns it into a daemon message.
  // Our own container holding it is fine: recreating it below is the whole point of `start`.
  for (const [what, port, owner] of [
    ["server", p.ports.server, p.ns.server],
    ["database", p.ports.db, p.ns.db],
  ] as const) {
    if (!p.managed && what === "database") continue;
    if (await portIsFree(port)) continue;
    const holder = containerOnPort(port);
    if (holder === owner) continue;
    throw new Error(
      holder
        ? `Port ${port} (${what}) is held by container ${holder}. Stop it, or change the port in warehousd.yml.`
        : `Port ${port} (${what}) is already in use. Change the port in warehousd.yml, or stop whatever holds it.`,
    );
  }

  if (imageExists(serverImage)) {
    report.step("Image", serverImage).done(`${image.source}, local`);
  } else {
    const pulling = report.step("Pulling", serverImage);
    try {
      ensureImage(serverImage);
      pulling.done(image.source);
    } catch (err: unknown) {
      pulling.fail();
      throw err;
    }
  }
  if (p.managed) {
    if (!imageExists("pgvector/pgvector:pg16")) {
      const pulling = report.step("Pulling", "pgvector/pgvector:pg16");
      try {
        ensureImage("pgvector/pgvector:pg16");
        pulling.done();
      } catch (err: unknown) {
        pulling.fail();
        throw err;
      }
    }
  }

  // Step 4: Ensure network
  ensureNetwork(p.ns.net, p.ns.label);

  // Step 5: Ensure database (if managed)
  if (p.managed) {
    ensureVolume(p.ns.volume, p.ns.label);
    const dbState = containerState(p.ns.db);
    if (dbState !== "running") {
      const dbStep = report.step("Starting", `${p.ns.db} → :${p.ports.db}`);
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
      dbStep.done();
    } else {
      report.step("Reusing", `${p.ns.db} → :${p.ports.db}`).done("already running");
    }
  }

  // Step 6: Compute database URLs
  let appUrlHost: string;
  let appUrlContainer: string;

  if (p.managed) {
    appUrlHost = `postgres://warehousd:${st.dbPassword}@localhost:${p.ports.db}/warehousd`;
    appUrlContainer = `postgres://warehousd:${st.dbPassword}@${p.ns.db}:5432/warehousd`;
  } else {
    // `Project` is a union on `managed`, so the URL is here by type rather than by assertion.
    appUrlHost = p.databaseUrl;
    appUrlContainer = appUrlHost;
  }

  // Step 7: Recreate server container
  const adminEmail = "admin@warehousd.local";
  const serverStep = report.step("Starting", `${p.ns.server} → :${p.ports.server}`);
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
      // The container stores only a hash of this, so this process stays the only holder of the
      // plaintext — which is what lets `start` keep printing it on every run.
      WAREHOUSD_DEV_CLIENT_SECRET: st.devClientSecret,
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

  serverStep.done();

  // Step 8: Poll health endpoint
  const appUrl = `http://localhost:${p.ports.server}`;
  const healthStep = report.step("Waiting", "health check");
  try {
    await pollHealth(appUrl, HEALTH_CHECK_TIMEOUT_MS);
    healthStep.done();
  } catch (err) {
    healthStep.fail();
    const containerLogs = logs(p.ns.server, 50);
    throw new Error(
      `Container health check failed: ${String(err)}\n\nContainer logs:\n${containerLogs}`,
      { cause: err },
    );
  }

  // Step 9: Connect and get dev client
  const db = new Pool({ connectionString: appUrlHost });
  try {
    const devClient = await getDevClient(db);
    if (!devClient) {
      const containerLogs = logs(p.ns.server, 50);
      throw new Error(`Failed to retrieve dev client. Container logs:\n${containerLogs}`);
    }

    // Step 10: Build and write outputs. The clientId comes from the database; the secret comes
    // from local state, because the database holds only its hash.
    const outputs = buildOutputs(p, appUrlHost, {
      clientId: devClient.clientId,
      clientSecret: st.devClientSecret,
    });
    writeOutputs(p.dir, outputs);

    return outputs;
  } finally {
    await db.end();
  }
}
