import type { DbProvider } from "./types";

/**
 * Railway Postgres is a plain container whose `POSTGRES_USER` is a real superuser, so nothing here
 * differs from a local Postgres: plain role names, `create role` and `create extension` both work,
 * and there is no pooler in front of it to drop startup parameters.
 *
 * `rlwy.net` is the public proxy hostname; `railway.internal` is the private-network one, which
 * only resolves from inside a Railway service and so never reaches a pre-flight run from a laptop.
 */
export const railway: DbProvider = {
  id: "railway",
  label: "Railway",
  matches: (url) =>
    url.hostname.endsWith(".railway.app") ||
    url.hostname.endsWith(".rlwy.net") ||
    url.hostname.endsWith(".railway.internal"),
  roleUsername: (_url, role) => role,
};
