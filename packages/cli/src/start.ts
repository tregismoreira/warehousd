import { Pool } from "pg";
import {
  assertRuntime,
  runtimeVersion,
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
import { hostFor } from "./db/hosts";
import { ensureState, writeOutputs, type Outputs } from "./state";
import { buildOutputs } from "./outputs";
import { resolveServerImage } from "./image-resolve";
import { portIsFree } from "./preflight";
import { waitForDatabaseAt } from "./db-preflight";
import { silentReporter, type Reporter } from "./ui/reporter";
import { getDevClient } from "@warehousd/broker";

const HEALTH_CHECK_TIMEOUT_MS = 180_000;
const HEALTH_CHECK_INTERVAL_MS = 1000;
// Shorter than the health check on purpose. This waits only for a local Postgres container to open
// its socket — seconds on a restart, a little longer on a first initialisation — and the failure it
// exists to catch is answered on the first attempt rather than waited out.
const DB_CONNECT_TIMEOUT_MS = 60_000;

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

/** The loopback address in a URL, swapped for the name a container reaches the host by. */
export function toContainerHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      parsed.hostname = HOST_GATEWAY_NAME;
    }
    return parsed.toString();
  } catch {
    // Not ours to mangle. A URL that will not parse is one the provider printed, and the
    // connection error it produces names it better than a rewrite would.
    return url;
  }
}

const HOST_GATEWAY_NAME = "host.docker.internal";

export async function runStart(
  dir: string,
  // No `verbose` here: it is a process-wide concern that program.ts hands to setVerbose() before
  // any Docker call, so threading it through this signature only offered a second way to set it.
  opts: { seed?: number; pull?: boolean; reporter?: Reporter } = {},
): Promise<Outputs> {
  const report = opts.reporter ?? silentReporter;

  // Step 1: Resolve project config.
  const p = resolveProject(dir);

  // Whose local database, when it is not warehousd's own container. Resolved here so that a
  // provider with no local stack is refused by name rather than by a missing subcommand later.
  const localDbHost = p.cfg.database?.provider ? hostFor(p.cfg.database.provider) : undefined;
  if (p.cfg.database?.provider && !localDbHost?.local) {
    throw new Error(
      `database.provider \`${p.cfg.database.provider}\` has no local stack, so \`warehousd start\` ` +
        `cannot run it here. Drop the key to use warehousd's own Postgres container, or set ` +
        `database.url to point at one you already run.`,
    );
  }

  // Step 2: Assert the container engine is available
  assertRuntime();

  const st = ensureState(p.dir);

  // Five steps on the ordinary path — check, server image, database, server, health — and two
  // more when warehousd runs its own Postgres: a second image to pull, and the credential check
  // against the volume that image populates. Counted here rather than incremented as it goes, so
  // the total is right on the first line rather than the last.
  report.plan(p.managed && !localDbHost ? 7 : 5);

  const check = report.step("Checking", "docker", "Checked docker");
  check.done(`version ${runtimeVersion()}`);

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
    const pulling = report.step("Pulling", serverImage, `Pulled ${serverImage}`);
    try {
      ensureImage(serverImage);
      pulling.done(image.source);
    } catch (err: unknown) {
      pulling.fail();
      throw err;
    }
  }
  if (p.managed && !localDbHost) {
    if (!imageExists("pgvector/pgvector:pg16")) {
      const pulling = report.step(
        "Pulling",
        "pgvector/pgvector:pg16",
        "Pulled pgvector/pgvector:pg16",
      );
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
  //
  // Three shapes, and the middle one is new: warehousd's own pgvector container, a provider's
  // local stack (`supabase start`), or a URL you already have. `localDbUrl` is non-null only in
  // the middle case, which is what the URL computation below branches on.
  let localDbUrl: string | null = null;
  if (p.managed && localDbHost?.local) {
    const step = report.step(
      "Starting",
      `${localDbHost.label} locally`,
      `${localDbHost.label} started locally`,
    );
    try {
      localDbUrl = await localDbHost.local.start({ projectDir: p.dir, say: (m) => report.note(m) });
      step.done(localDbHost.label);
    } catch (err: unknown) {
      step.fail();
      throw err;
    }
  } else if (p.managed) {
    ensureVolume(p.ns.volume, p.ns.label);
    const dbState = containerState(p.ns.db);
    if (dbState !== "running") {
      const dbStep = report.step("Starting", "the database", "Database started");
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
      dbStep.done(`:${p.ports.db}`);
    } else {
      report
        .step("Reusing", "the database", "Database reused")
        .done(`already running on :${p.ports.db}`);
    }
  }

  // Step 6: Compute database URLs
  let appUrlHost: string;
  let appUrlContainer: string;

  if (localDbUrl) {
    // A provider's local stack listens on the *host*, not on this project's docker network, so
    // the server container cannot reach it by the loopback address the CLI uses. `host.docker.internal`
    // is the name that resolves back out — mapped explicitly below, because Linux does not
    // provide it the way Docker Desktop does.
    appUrlHost = localDbUrl;
    appUrlContainer = toContainerHost(localDbUrl);
  } else if (p.managed) {
    appUrlHost = `postgres://warehousd:${st.dbPassword}@localhost:${p.ports.db}/warehousd`;
    appUrlContainer = `postgres://warehousd:${st.dbPassword}@${p.ns.db}:5432/warehousd`;
  } else {
    // `Project` is a union on `managed`, so the URL is here by type rather than by assertion.
    appUrlHost = p.databaseUrl;
    appUrlContainer = appUrlHost;
  }

  // Step 6b: Prove the credential in state.json opens this database, before anything depends on it.
  //
  // Only for our own container on our own volume: that is the pair that can come apart, because
  // Postgres takes a password only from an empty data directory and the volume outlives the state
  // file. A URL the user supplied is theirs to get right, and a provider's local stack manages its
  // own credentials — neither has this failure mode, and probing them would only add a wait.
  if (p.managed && !localDbHost) {
    const dbCheck = report.step(
      "Checking",
      "the database credentials",
      "Database credentials check out",
    );
    try {
      await waitForDatabaseAt(appUrlHost, {
        volume: p.ns.volume,
        stateFile: ".warehousd/state.json",
        timeoutMs: DB_CONNECT_TIMEOUT_MS,
      });
      dbCheck.done();
    } catch (err: unknown) {
      dbCheck.fail();
      throw err;
    }
  }

  // Step 7: Recreate server container
  const adminEmail = "admin@warehousd.local";
  const serverStep = report.step("Starting", "the server", "Server started");
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
      WAREHOUSD_MASK_KEY: st.maskKey,
      WAREHOUSD_DEMO: String(p.cfg.demo ?? false),
      WAREHOUSD_SEED: String(opts.seed ?? 42),
    },
    ports: {
      [`127.0.0.1:${p.ports.server}`]: "8722",
    },
    volumes: {
      "/project": p.dir,
    },
    // Only when the database is on the host rather than on this network. Docker Desktop resolves
    // this name unaided; Linux needs the mapping, and adding it unconditionally would put a
    // pointless `--add-host` on every ordinary run.
    ...(localDbUrl ? { extraHosts: { [HOST_GATEWAY_NAME]: "host-gateway" } } : {}),
  });

  serverStep.done(`:${p.ports.server}`);

  // Step 8: Poll health endpoint
  const appUrl = `http://localhost:${p.ports.server}`;
  const healthStep = report.step("Waiting", "for the server to answer", "Healthy");
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
