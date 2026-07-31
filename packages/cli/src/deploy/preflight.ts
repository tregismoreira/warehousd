import { loadConfig, envRefs, type WarehousdConfig } from "@warehousd/broker";
import { FlyError, assertFly } from "../fly";

export type PreflightCheck = { id: string; ok: boolean; detail: string };
export type PreflightResult =
  { ok: true; checks: PreflightCheck[] } | { ok: false; checks: PreflightCheck[] };

export async function preflight(input: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  allowLocalLogin: boolean;
  ssoLookup?: ((dbUrl: string) => Promise<boolean>) | undefined;
}): Promise<PreflightResult> {
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

  // sso-or-local-login: check allowLocalLogin OR (SSO_ISSUER && SSO_CLIENT_ID && SSO_CLIENT_SECRET) OR (cfg.deploy?.database.url && ssoLookup)
  let ssoCheck: PreflightCheck | null;
  if (input.allowLocalLogin) {
    ssoCheck = {
      id: "sso-or-local-login",
      ok: true,
      detail: "Local login allowed",
    };
  } else {
    const ssoEnv = input.env.SSO_ISSUER && input.env.SSO_CLIENT_ID && input.env.SSO_CLIENT_SECRET;
    if (ssoEnv) {
      ssoCheck = {
        id: "sso-or-local-login",
        ok: true,
        detail: "SSO configured",
      };
    } else if (cfg?.deploy?.database.url && input.ssoLookup) {
      // Async check needed; will be handled separately
      ssoCheck = null;
    } else {
      ssoCheck = {
        id: "sso-or-local-login",
        ok: false,
        detail:
          "allowLocalLogin is false and neither SSO trio nor ssoLookup with database.url is configured",
      };
    }
  }

  if (ssoCheck) {
    checks.push(ssoCheck);
  } else if (cfg?.deploy?.database.url && input.ssoLookup && !input.allowLocalLogin) {
    // Perform the async ssoLookup
    try {
      const ssoPresent = await input.ssoLookup(cfg.deploy.database.url);
      checks.push({
        id: "sso-or-local-login",
        ok: ssoPresent,
        detail: ssoPresent ? "SSO configured in database" : "No local login and no SSO configured",
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : "ssoLookup failed";
      checks.push({
        id: "sso-or-local-login",
        ok: false,
        detail: `Failed to check SSO: ${detail}`,
      });
    }
  } else if (cfg?.deploy?.database.url && !input.ssoLookup && !input.allowLocalLogin) {
    const ssoEnv =
      !!input.env.SSO_ISSUER && !!input.env.SSO_CLIENT_ID && !!input.env.SSO_CLIENT_SECRET;
    checks.push({
      id: "sso-or-local-login",
      ok: ssoEnv,
      detail: ssoEnv
        ? "SSO configured"
        : "No local login, no SSO trio in env, and no ssoLookup provided",
    });
  }

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
