import { readState, readOutputs } from "./../state";

// The counterpart to masking the `start` panel. Everything the CLI knows is still available — it
// just has to be asked for, so a screen share or a scrollback buffer is not the thing that hands
// it over.

export type SecretEntry = { label: string; value: string; secret: boolean };

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
    entries.push({ label: "Database URL", value: outputs.databaseUrl, secret: true });
    entries.push({ label: "Dev client ID", value: outputs.devClient.clientId, secret: false });
    entries.push({
      label: "Dev client secret",
      value: outputs.devClient.clientSecret,
      secret: true,
    });
  }
  if (state) {
    entries.push({ label: "Admin email", value: "admin@warehousd.local", secret: false });
    entries.push({ label: "Admin password", value: state.adminPassword, secret: true });
    entries.push({ label: "Database password", value: state.dbPassword, secret: true });
  }
  return entries;
}

/** Shape for `--json`: full values, because a machine reading this asked for them explicitly. */
export function secretsJson(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of collectSecrets(dir)) out[e.label] = e.value;
  return out;
}
