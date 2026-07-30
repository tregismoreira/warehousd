// The one place a token's scope string becomes an environment.
//
// Both token-authenticated context constructors computed this inline as
// `scopes.includes("env:live") ? "live" : "dev"`. The logic is unchanged — this only stops it
// being written twice, so the two auth boundaries cannot drift on the question of which data
// schema a token reaches.
//
// Absence means dev, deliberately, and it is documented that way (docs/architecture.md, and the
// env-as-scope acceptance gate in packages/broker/test/db-roles.test.ts): `resolveEnvScopes`
// leaves a caller that requested no env scope untouched, and the adapter supplies the floor.
// The default is in the safe direction — dev is `data_synth`, generated data. `env:live` is never
// implied: it reaches real data only when the scope is explicitly present, which requires both a
// client policy allowing it and a user with an approved live grant.
export function envFromScopes(scopes: string[]): "dev" | "live" {
  // A token carrying BOTH is not one this system issues — §6.1 rule 3 collapses to exactly one at
  // issuance, via the env picker when both survive. Reading it as live preserves the existing
  // behaviour rather than inventing a new one for a token that should not exist.
  return scopes.includes("env:live") ? "live" : "dev";
}

export function scopesOf(raw: string | null | undefined): string[] {
  return (raw ?? "").split(" ").filter(Boolean);
}
