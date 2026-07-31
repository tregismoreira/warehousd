import { createInterface } from "node:readline/promises";
import { Pool } from "pg";
import { join } from "node:path";
import { loadConfig, envRefs } from "@warehousd/broker";
import { preflight } from "./deploy/preflight";
import { readDeployOutputs, ensureState, writeDeployOutputs, stateDir } from "./state";
import { writeBundle } from "./deploy/bundle";
import { resolveBaseImage, renderDeployDockerfile, renderFlyToml } from "./deploy/fly-toml";
import { renderConfigDiff } from "./deploy/diff";
import { confirmDestroy } from "./deploy/destroy";
import { buildDeployOutputs, formatDeployOutputs } from "./deploy/outputs";
import { run, appExists } from "./fly";

const HEALTH_CHECK_TIMEOUT_MS = 180_000;
const HEALTH_CHECK_INTERVAL_MS = 1000;
const SSO_LOOKUP_TIMEOUT_MS = 5000;

// Better Auth's SSO plugin owns this table, so the column casing is its own — quoted, not
// snake_case like the rest of app.*. Reads one row and nothing from it: whether a provider exists
// is the entire question, and issuer URLs and client ids are not this command's business.
//
// A brand-new database has no app schema at all yet, which is not a failure — it is a deployment
// that has never booted, and it genuinely has no SSO provider. 42P01 (undefined_table) is
// therefore `false`, while a refused connection or a bad password propagates: pre-flight has to be
// able to tell "no SSO configured" from "could not find out".
async function ssoConfiguredInDatabase(dbUrl: string): Promise<boolean> {
  const db = new Pool({
    connectionString: dbUrl,
    connectionTimeoutMillis: SSO_LOOKUP_TIMEOUT_MS,
    statement_timeout: SSO_LOOKUP_TIMEOUT_MS,
  });
  try {
    const res = await db.query(`select 1 from app."ssoProvider" limit 1`);
    return (res.rowCount ?? 0) > 0;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "42P01") return false;
    throw err;
  } finally {
    await db.end();
  }
}

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

export async function runDeploy(
  dir: string,
  opts: { allowLocalLogin?: boolean; yes?: boolean; destroy?: boolean; localBuild?: boolean },
): Promise<void> {
  // Destroy path first: if opts.destroy, prompt and confirm
  if (opts.destroy) {
    const cfg = loadConfig(dir);
    if (!cfg.deploy) {
      throw new Error("No deploy block in warehousd.yml; cannot destroy");
    }

    const appName = cfg.deploy.app_name;
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const typed = await rl.question(
      `This will destroy ${appName} and its database, which may hold real data. Type the app name to confirm: `,
    );
    rl.close();

    if (!confirmDestroy(typed, appName)) {
      console.log("Not confirmed. Exiting without destroying.");
      return;
    }

    // Destroy the app
    run(["apps", "destroy", appName, "--yes"]);

    // Destroy the database if managed
    if (cfg.deploy.database.managed) {
      const dbAppName = `${appName}-db`;
      run(["apps", "destroy", dbAppName, "--yes"]);
    }

    return;
  }

  // Deploy path: run preflight first
  const preflightResult = await preflight({
    projectDir: dir,
    env: process.env,
    allowLocalLogin: !!opts.allowLocalLogin,
    ssoLookup: ssoConfiguredInDatabase,
  });

  if (!preflightResult.ok) {
    for (const check of preflightResult.checks) {
      if (!check.ok) {
        console.log(`  ✗ ${check.id}: ${check.detail}`);
      }
    }
    process.exit(1);
  }

  // Load config and extract deploy section
  const cfg = loadConfig(dir);
  if (!cfg.deploy) {
    console.log("  ✗ deploy-block-present: Add a deploy: block to warehousd.yml");
    process.exit(1);
  }

  const deploy = cfg.deploy;
  const appName = deploy.app_name;
  const region = deploy.region;

  // Diff with previous state
  const prevOutputs = readDeployOutputs(dir);
  const diffText = renderConfigDiff(prevOutputs?.configSnapshot ?? null, cfg);
  console.log(diffText);

  // Prompt for confirmation unless --yes
  if (!opts.yes) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await rl.question("Apply these changes? [y/N] ");
    rl.close();

    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  // Ensure state (generates secrets)
  const state = ensureState(dir);

  // Create app if it doesn't exist
  if (!appExists(appName)) {
    run(["apps", "create", appName]);
  }

  // Create database if managed.
  //
  // `null` for the managed case is the point, not an omission. `postgres attach` generates a user
  // and password and sets DATABASE_URL on the app itself; those credentials are Fly's, are shown
  // once, and cannot be read back out. Any URL invented here — the old code built one from the
  // *local* Docker password in state.json — would simply be wrong. The entrypoint falls back to
  // DATABASE_URL, which is the value that actually works.
  let databaseUrl: string | null;
  if (deploy.database.managed) {
    const dbAppName = `${appName}-db`;
    if (!appExists(dbAppName)) {
      run(["postgres", "create", "--name", dbAppName, "--region", region]);
      run(["postgres", "attach", "--app", appName, dbAppName]);
    }
    databaseUrl = null;
  } else {
    databaseUrl = deploy.database.url ?? null;
  }

  // Build secrets input as KEY=VALUE lines
  const appUrl = `https://${appName}.fly.dev`;

  // The four role-scoped URLs are deliberately NOT set here. They are derived server-side from
  // APP_DATABASE_URL and WAREHOUSD_DATA_ROLE_PASSWORD (apps/web/app/lib/broker.ts), which is the
  // only thing that can work for `database.managed`: Fly generates the Postgres credentials during
  // `postgres attach` and exposes them to the app as DATABASE_URL, so no value this process could
  // compute would be the real one. Sending a derived URL from here shipped four `https://` strings
  // — dataRoleUrl takes the owner *database* URL, and it was being handed the app's public HTTPS
  // address.
  const secretsInput = [
    ...(databaseUrl ? [`APP_DATABASE_URL=${databaseUrl}`] : []),
    `WAREHOUSD_DATA_ROLE_PASSWORD=${state.dataRolePassword}`,
    `BETTER_AUTH_SECRET=${state.betterAuthSecret}`,
    `BETTER_AUTH_URL=${appUrl}`,
    `WAREHOUSD_ADMIN_EMAIL=admin@${appName}.fly.dev`,
    `WAREHOUSD_ADMIN_PASSWORD=${state.adminPassword}`,
    `WAREHOUSD_DEV_CLIENT_SECRET=${state.devClientSecret}`,
  ];

  // Add WAREHOUSD_DISABLE_LOCAL_LOGIN unless allowLocalLogin is set
  if (!opts.allowLocalLogin) {
    secretsInput.push("WAREHOUSD_DISABLE_LOCAL_LOGIN=true");
  }

  // Add SSO and other env refs if present
  if (process.env.SSO_ISSUER) secretsInput.push(`SSO_ISSUER=${process.env.SSO_ISSUER}`);
  if (process.env.SSO_CLIENT_ID) secretsInput.push(`SSO_CLIENT_ID=${process.env.SSO_CLIENT_ID}`);
  if (process.env.SSO_CLIENT_SECRET)
    secretsInput.push(`SSO_CLIENT_SECRET=${process.env.SSO_CLIENT_SECRET}`);
  if (process.env.ANTHROPIC_API_KEY)
    secretsInput.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);

  // Add every envRefs name if present in process.env
  const refs = envRefs(dir);
  for (const ref of refs) {
    if (
      ref !== "DB_URL" &&
      !(ref in { SSO_ISSUER: 1, SSO_CLIENT_ID: 1, SSO_CLIENT_SECRET: 1, ANTHROPIC_API_KEY: 1 })
    ) {
      if (process.env[ref]) {
        secretsInput.push(`${ref}=${process.env[ref]}`);
      }
    }
  }

  // Import secrets
  run(["secrets", "import", "--app", appName, "--stage"], { input: secretsInput.join("\n") });

  // Write bundle and deploy files
  const deployDir = join(stateDir(dir), "deploy");
  const contextDir = join(deployDir, "context");
  writeBundle(cfg, dir, contextDir);

  const baseImage = resolveBaseImage(cfg);
  const dockerfile = renderDeployDockerfile(baseImage);
  const dockerfilePath = join(deployDir, "Dockerfile");
  const fs = await import("node:fs");
  fs.writeFileSync(dockerfilePath, dockerfile);

  const flyTomlContent = renderFlyToml({ appName, region });
  const flyTomlPath = join(deployDir, "fly.toml");
  fs.writeFileSync(flyTomlPath, flyTomlContent);

  // Deploy using flyctl
  const deployArgs = ["deploy", "--config", flyTomlPath, "--dockerfile", dockerfilePath];
  if (!opts.localBuild) {
    deployArgs.push("--remote-only");
  } else {
    // Local build needs Docker to be available
    const docker = await import("./docker");
    docker.assertDocker();
  }

  run(deployArgs);

  // Poll health endpoint
  try {
    await pollHealth(`${appUrl}/api/health`, HEALTH_CHECK_TIMEOUT_MS);
  } catch (err: unknown) {
    // On timeout, fetch flyctl logs
    const logsOutput = run(["logs", "--app", appName]);
    throw new Error(`Container health check failed: ${String(err)}\n\nFly logs:\n${logsOutput}`, {
      cause: err,
    });
  }

  // Write outputs and print
  const outputs = buildDeployOutputs({
    appName,
    cfg,
    databaseUrl: deploy.database.managed ? null : databaseUrl,
    now: new Date(),
  });

  writeDeployOutputs(dir, outputs);

  const adminEmail = `admin@${appName}.fly.dev`;
  console.log(formatDeployOutputs(outputs, { adminEmail, adminPassword: state.adminPassword }));
}
