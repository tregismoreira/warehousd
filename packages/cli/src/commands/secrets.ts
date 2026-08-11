import { readState, readOutputs } from "./../state";

// The counterpart to masking the `start` panel. Everything the CLI knows is still available — it
// just has to be asked for, so a screen share or a scrollback buffer is not the thing that hands
// it over.

/**
 * `kind` is which concept icon the label carries, not a second copy of `secret`.
 *
 * Three of these are credentials for a client, two are the admin's login and one is the database's
 * own password, and the icon is what makes the three groups visible without three headings.
 */
export type SecretKind = "secret" | "login" | "database";
export type SecretEntry = { label: string; value: string; secret: boolean; kind: SecretKind };

export function collectSecrets(dir: string): SecretEntry[] {
  const state = readState(dir);
  const outputs = readOutputs(dir);

  if (!state && !outputs) {
    throw new Error(
      "No secrets yet — .warehousd/state.json does not exist. Run `warehousd start` first.",
    );
  }

  const entries: SecretEntry[] = [];
  if (outputs) {
    entries.push({
      label: "Database URL",
      value: outputs.databaseUrl,
      secret: true,
      kind: "secret",
    });
    entries.push({
      label: "Dev client ID",
      value: outputs.devClient.clientId,
      secret: false,
      kind: "secret",
    });
    entries.push({
      label: "Dev client secret",
      value: outputs.devClient.clientSecret,
      secret: true,
      kind: "secret",
    });
  }
  if (state) {
    entries.push({
      label: "Admin email",
      value: "admin@warehousd.local",
      secret: false,
      kind: "login",
    });
    entries.push({
      label: "Admin password",
      value: state.adminPassword,
      secret: true,
      kind: "login",
    });
    entries.push({
      label: "Database password",
      value: state.dbPassword,
      secret: true,
      kind: "database",
    });
  }
  return entries;
}

/** Shape for `--json`: full values, because a machine reading this asked for them explicitly. */
export function secretsJson(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of collectSecrets(dir)) out[e.label] = e.value;
  return out;
}
