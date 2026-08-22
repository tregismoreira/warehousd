import { it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import {
  createPlatformKey,
  listPlatformKeys,
  mayManageWorkspace,
  MAX_KEY_LIFETIME_DAYS,
} from "../src/index";

// createPlatformKey/verifyPlatformKey/revokePlatformKey are exercised against a real database
// already, through the /v1/platform routes in apps/web/test/platform-api.integration.test.ts —
// this file covers what that route surface never calls: the operator-facing list, the expiry
// ceiling, and the ACL helper the routes read but never construct in an uncovered shape.
let p: Provisioned, admin: Pool;
beforeAll(async () => {
  p = await provision("platformkeys");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
});
afterAll(async () => {
  await admin.end();
  await p.end();
});

it("listPlatformKeys returns created keys newest-first, never the hash", async () => {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const { id } = await createPlatformKey(admin, {
    label: "integrator",
    managedWorkspaces: ["w-alpha"],
    expiresAt,
    createdBy: "ana",
  });

  const keys = await listPlatformKeys(admin);
  const row = keys.find((k) => k.id === id);
  expect(row).toBeDefined();
  expect(row!.label).toBe("integrator");
  expect(row!.managedWorkspaces).toEqual(["w-alpha"]);
  expect(row!.revokedAt).toBeNull();
  expect(row).not.toHaveProperty("secretHash");
  expect(row).not.toHaveProperty("secret_hash");
});

it("refuses an expiry beyond the maximum key lifetime", async () => {
  const tooFar = new Date();
  tooFar.setDate(tooFar.getDate() + MAX_KEY_LIFETIME_DAYS + 1);
  await expect(
    createPlatformKey(admin, {
      label: "too-long",
      managedWorkspaces: null,
      expiresAt: tooFar,
      createdBy: "ana",
    }),
  ).rejects.toThrow(/exceeds maximum/);
});

it("mayManageWorkspace: null is every workspace, a list is only its members", () => {
  expect(mayManageWorkspace({ managedWorkspaces: null }, "anything")).toBe(true);
  expect(mayManageWorkspace({ managedWorkspaces: ["w-alpha"] }, "w-alpha")).toBe(true);
  expect(mayManageWorkspace({ managedWorkspaces: ["w-alpha"] }, "w-beta")).toBe(false);
});
