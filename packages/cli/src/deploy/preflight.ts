import { loadConfig, envRefs, type WarehousdConfig } from "@warehousd/broker";
import { FlyError, assertFly } from "../fly";

export type PreflightCheck = { id: string; ok: boolean; detail: string };
export type PreflightResult =
  { ok: true; checks: PreflightCheck[] } | { ok: false; checks: PreflightCheck[] };

export type PreflightInput = {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  allowLocalLogin: boolean;
  ssoLookup?: ((dbUrl: string) => Promise<boolean>) | undefined;
};

// Deploying with local password login still enabled, and no identity provider behind it, is the
// difference between a demo and a public front door. It is allowed — some operators genuinely want
// it — but only when asked for explicitly, never by omission.
//
// Two sources, because neither alone covers the lifecycle. The env trio is what a first deploy has:
// with `database.managed: true` there is no database yet to hold a provider, so a DB-only check
// could never pass and the gate would be unsatisfiable. The database is what a running deployment
// has: an admin who registered an IdP through the admin UI has no SSO variables in their shell, and
// asking them to invent some, or to pass --allow-local-login when SSO is genuinely configured,
// would train them to reach for the override.
async function ssoOrLocalLoginCheck(
  input: PreflightInput,
  cfg: WarehousdConfig | null,
): Promise<PreflightCheck> {
  const id = "sso-or-local-login";

  if (input.allowLocalLogin) {
    return { id, ok: true, detail: "--allow-local-login passed; local password login stays on" };
  }

  if (input.env.SSO_ISSUER && input.env.SSO_CLIENT_ID && input.env.SSO_CLIENT_SECRET) {
    return { id, ok: true, detail: "SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET are all set" };
  }

  const dbUrl = cfg?.deploy?.database.url;
  if (dbUrl && input.ssoLookup) {
    try {
      if (await input.ssoLookup(dbUrl)) {
        return { id, ok: true, detail: "an SSO provider is registered in the target database" };
      }
      return {
        id,
        ok: false,
        detail:
          "no SSO provider is registered in the target database, and no SSO_ISSUER/SSO_CLIENT_ID/" +
          "SSO_CLIENT_SECRET in the environment. Register one in the admin UI, set those " +
          "variables, or pass --allow-local-login.",
      };
    } catch (err: unknown) {
      // A database that cannot be reached is not evidence that SSO is configured. Refuse, and say
      // it was the lookup that failed rather than reporting it as "SSO is not set up".
      const reason = err instanceof Error ? err.message : String(err);
      return { id, ok: false, detail: `could not check the target database for SSO: ${reason}` };
    }
  }

  return {
    id,
    ok: false,
    detail:
      "no SSO configured. Set SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET, register a " +
      "provider in the admin UI (requires deploy.database.url so it can be read), or pass " +
      "--allow-local-login to deploy with local password login enabled.",
  };
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  // env-refs-resolve: check that every name from envRefs is in input.env
  const refs = envRefs(input.projectDir);
  const missing = refs.filter((name) => !(name in input.env));

  const envRefsCheck: PreflightCheck = {
    id: "env-refs-resolve",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? "All environment references resolved"
        : `Missing environment variables: ${missing.join(", ")}`,
  };
  checks.push(envRefsCheck);

  // If env refs don't resolve, we cannot call loadConfig and cannot evaluate demo/deploy checks.
  // If env refs do resolve, load the config to check demo and deploy.
  let cfg: WarehousdConfig | null = null;
  let deployBlockOk: boolean;
  let deployBlockDetail: string;
  let demoOffOk: boolean;
  let demoOffDetail: string;

  if (missing.length === 0) {
    try {
      cfg = loadConfig(input.projectDir);
      deployBlockOk = !!cfg.deploy;
      deployBlockDetail = cfg.deploy
        ? "Deploy block present"
        : "Add a deploy: block to warehousd.yml; see docs/cli.md";
      demoOffOk = cfg.demo !== true && input.env.WAREHOUSD_DEMO !== "true";
      const hasYamlDemo = cfg.demo === true;
      const hasEnvDemo = input.env.WAREHOUSD_DEMO === "true";
      demoOffDetail =
        hasYamlDemo && hasEnvDemo
          ? "demo: true in YAML and WAREHOUSD_DEMO=true in environment"
          : hasYamlDemo
            ? "demo: true in warehousd.yml"
            : hasEnvDemo
              ? "WAREHOUSD_DEMO=true in environment"
              : "Demo mode is off";
    } catch (err: unknown) {
      // loadConfig threw; mark checks as unevaluable
      const detail = err instanceof Error ? err.message : "Failed to load config";
      deployBlockOk = false;
      deployBlockDetail = `Could not evaluate: ${detail}`;
      demoOffOk = false;
      demoOffDetail = `Could not evaluate: ${detail}`;
    }
  } else {
    // env refs didn't resolve; cannot evaluate demo and deploy checks without resolving env refs.
    // Mark them as unevaluable and the operator will fix env refs first.
    deployBlockOk = false;
    deployBlockDetail = "Could not evaluate: resolve environment variables first to load config";
    demoOffOk = false;
    demoOffDetail = "Could not evaluate: resolve environment variables first to load config";
  }

  // Add deploy-block-present and demo-off checks (only once each)
  checks.push({
    id: "deploy-block-present",
    ok: deployBlockOk,
    detail: deployBlockDetail,
  });
  checks.push({
    id: "demo-off",
    ok: demoOffOk,
    detail: demoOffDetail,
  });

  checks.push(await ssoOrLocalLoginCheck(input, cfg));

  // flyctl-ready: check assertFly() doesn't throw
  let flyReady = true;
  let flyDetail = "flyctl is ready";
  try {
    assertFly();
  } catch (err: unknown) {
    flyReady = false;
    if (err instanceof FlyError) {
      flyDetail = err.message;
    } else {
      flyDetail = err instanceof Error ? err.message : "Unknown error checking flyctl";
    }
  }
  checks.push({
    id: "flyctl-ready",
    ok: flyReady,
    detail: flyDetail,
  });

  // Determine overall result: ok if every check is ok
  const allOk = checks.every((c) => c.ok);
  if (allOk) {
    return { ok: true, checks };
  } else {
    return { ok: false, checks };
  }
}
