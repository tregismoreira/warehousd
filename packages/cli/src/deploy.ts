import { createInterface } from "node:readline/promises";
import { Pool } from "pg";
import { join } from "node:path";
import { loadConfig, envRefs, type DeployConfig, type WarehousdConfig } from "@warehousd/broker";
import { preflight } from "./deploy/preflight";
import { databaseCapabilities } from "./deploy/database-checks";
import { readDeployOutputs, ensureState, writeDeployOutputs, stateDir, type State } from "./state";
import { writeBundle } from "./deploy/bundle";
import { renderConfigDiff } from "./deploy/diff";
import { confirmDestroy } from "./deploy/destroy";
import { buildDeployOutputs, formatDeployOutputs } from "./deploy/outputs";
import { targetFor, type TargetContext } from "./deploy/targets";
import { existingMigrations } from "./migrate";
import { renderChecks } from "./ui/render";
import { plainTheme, type Theme } from "./ui/theme";

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

/** `baseUrl` is the app's root; the endpoint is appended here and nowhere else. */
async function pollHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  const interval = HEALTH_CHECK_INTERVAL_MS;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
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

/**
 * The bag every `DeployTarget` method is called with. Assembled here, in the one place that has
 * read the config, so a target never loads it again and never disagrees about where the bundle is.
 */
function targetContext(args: {
  dir: string;
  cfg: WarehousdConfig;
  deploy: DeployConfig;
  state: State | null;
  localBuild: boolean;
  say: (msg: string) => void;
}): TargetContext {
  const deployDir = join(stateDir(args.dir), "deploy");
  return {
    projectDir: args.dir,
    cfg: args.cfg,
    deploy: args.deploy,
    appName: args.deploy.app_name,
    region: args.deploy.region,
    state: args.state,
    deployDir,
    contextDir: join(deployDir, "context"),
    localBuild: args.localBuild,
    say: args.say,
  };
}

export async function runDeploy(
  dir: string,
  opts: {
    allowLocalLogin?: boolean;
    allowDisabledAudit?: boolean;
    yes?: boolean;
    destroy?: boolean;
    localBuild?: boolean;
    theme?: Theme | undefined;
    showSecrets?: boolean | undefined;
    json?: boolean | undefined;
    quiet?: boolean | undefined;
  },
): Promise<void> {
  // Defaults to the inert theme so a caller that passes nothing still gets plain, colourless
  // output rather than escape codes it did not ask for.
  const theme = opts.theme ?? plainTheme;
  const json = opts.json ?? false;

  // Same split as every other command: narration and failures on stderr, the result on stdout, so
  // `warehousd deploy --json | jq` gets JSON and nothing else. All of this used to be console.log.
  const say = (msg: string) => {
    if (!opts.quiet && !json) process.stderr.write(`${msg}\n`);
  };
  const complain = (msg: string) => process.stderr.write(`${msg}\n`);

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
      complain("Not confirmed. Exiting without destroying.");
      return;
    }

    const target = targetFor(cfg.deploy.target);
    await target.destroy(
      targetContext({
        dir,
        cfg,
        deploy: cfg.deploy,
        state: null,
        localBuild: !!opts.localBuild,
        say,
      }),
    );

    return;
  }

  // Deploy path: run preflight first
  const preflightResult = await preflight({
    projectDir: dir,
    env: process.env,
    allowLocalLogin: !!opts.allowLocalLogin,
    allowDisabledAudit: !!opts.allowDisabledAudit,
    ssoLookup: ssoConfiguredInDatabase,
    dbCapabilities: databaseCapabilities,
  });

  if (!preflightResult.ok) {
    // Through the shared renderer, so a failed pre-flight degrades to ASCII off a terminal and
    // honours NO_COLOR — the ✗ used to be hardcoded here, which neither did.
    const failed = preflightResult.checks.filter((c) => !c.ok);
    complain(`\n${renderChecks(failed, theme)}\n`);
    process.exit(1);
  }

  // Load config and extract deploy section
  const cfg = loadConfig(dir);
  if (!cfg.deploy) {
    complain(
      `\n${renderChecks(
        [
          {
            id: "deploy-block-present",
            ok: false,
            detail: "add a `deploy:` block to warehousd.yml",
          },
        ],
        theme,
      )}\n`,
    );
    process.exit(1);
  }

  const deploy = cfg.deploy;
  const appName = deploy.app_name;
  const target = targetFor(deploy.target);

  // Diff with previous state
  const prevOutputs = readDeployOutputs(dir);
  const diffText = renderConfigDiff(prevOutputs?.configSnapshot ?? null, cfg);
  say(diffText);

  // Prompt for confirmation unless --yes
  if (!opts.yes) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await rl.question("Apply these changes? [y/N] ");
    rl.close();

    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      complain("Aborted.");
      return;
    }
  }

  // Ensure state (generates secrets)
  const state = ensureState(dir);
  const ctx = targetContext({
    dir,
    cfg,
    deploy,
    state,
    localBuild: !!opts.localBuild,
    say,
  });

  await target.ensureApp(ctx);

  // Under `managed: true` the target provisions its own Postgres and says what URL, if any, came
  // back. A target with no `provisionDatabase` cannot honour `managed` at all, and saying so here
  // is better than the release command failing with no database and no explanation.
  let databaseUrl: string | null;
  if (deploy.database.managed) {
    if (!target.provisionDatabase) {
      throw new Error(
        `deploy.database.managed is not supported on ${target.label}. ` +
          `Set deploy.database.url to a Postgres you run instead.`,
      );
    }
    databaseUrl = await target.provisionDatabase(ctx);
  } else {
    databaseUrl = deploy.database.url ?? null;
  }

  // Build secrets input as KEY=VALUE lines
  const appUrl = await target.appUrl(ctx);
  // Falls back to the app name when the target serves no URL of its own (a Compose stack the
  // operator points their own hostname at). It is a seed for the admin account's address, not a
  // route to anything.
  const adminEmail = `admin@${appUrl ? new URL(appUrl).host : appName}`;

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
    // Omitted, not empty, when the target serves no URL of its own: Better Auth reads its own
    // default from the request when this is unset, and `BETTER_AUTH_URL=null` would break every
    // callback rather than fall back.
    ...(appUrl ? [`BETTER_AUTH_URL=${appUrl}`] : []),
    `WAREHOUSD_ADMIN_EMAIL=${adminEmail}`,
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

  await target.setSecrets(ctx, secretsInput);

  // The bundle is written before the target ships it, and after the secrets are staged — the order
  // the Fly runbook has always used, kept because a target that stages secrets separately from the
  // release wants them in place before the image arrives.
  writeBundle(cfg, dir, ctx.contextDir);

  await target.deploy(ctx);

  // Only a target that serves a URL has anything to poll. A stack the operator has yet to start
  // would just time out here for three minutes and then be reported as a failed deploy.
  if (appUrl) {
    try {
      await pollHealth(appUrl, HEALTH_CHECK_TIMEOUT_MS);
    } catch (err: unknown) {
      const logsOutput = await target.logs?.(ctx);
      const trailer = logsOutput ? `\n\n${target.label} logs:\n${logsOutput}` : "";
      throw new Error(`Container health check failed: ${String(err)}${trailer}`, { cause: err });
    }
  }

  // Write outputs and print
  const outputs = buildDeployOutputs({
    // `http://localhost:<port>` is what a stack the operator runs themselves publishes, and what
    // `warehousd start` prints for the same thing (src/outputs.ts).
    baseUrl: appUrl ?? `http://localhost:${cfg.server.port}`,
    cfg,
    databaseUrl: deploy.database.managed ? null : databaseUrl,
    now: new Date(),
    // Recorded so the next deploy's pre-flight can tell a migration written for this change from
    // one that was already there.
    migrationVersions: existingMigrations(dir),
  });

  writeDeployOutputs(dir, outputs);

  if (json) {
    // The machine contract, matching `start --json`: full values, because a caller that asked for
    // JSON asked for the credential too. This is the payload a CI deploy wants back.
    process.stdout.write(
      `${JSON.stringify({ ...outputs, adminEmail, adminPassword: state.adminPassword }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(
    `${formatDeployOutputs(
      outputs,
      {
        adminEmail,
        adminPassword: state.adminPassword,
        target: { label: target.label, databaseHint: target.databaseHint },
      },
      { theme, showSecrets: opts.showSecrets ?? false },
    )}\n`,
  );
}
