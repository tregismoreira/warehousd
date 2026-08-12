import { Pool } from "pg";
import {
  loadConfig,
  workspacesEnabled,
  createPlatformKey,
  listPlatformKeys,
  revokePlatformKey,
  type PlatformKeyInfo,
} from "@warehousd/broker";

// The bootstrap problem: the first platform key cannot come from the API it unlocks, so this is
// the one place a platform key is minted outside `/v1/platform/*`. Everything else about the
// credential — hashing, the ACL semantics of `managedWorkspaces`, the lifetime ceiling — comes
// from packages/broker/src/credentials/platform-keys.ts; this file is wiring, not a second
// implementation.

export class PlatformDisabledError extends Error {
  constructor() {
    super("Platform key management is disabled.");
  }
}

function assertEnabled(projectDir: string): void {
  if (!workspacesEnabled(loadConfig(projectDir))) throw new PlatformDisabledError();
}

export type CreatePlatformKeyOpts = {
  label: string;
  allWorkspaces: boolean;
  workspaces?: string[] | undefined;
  days: number;
};

export type CreatePlatformKeyResult = {
  id: string;
  secret: string;
  managedWorkspaces: string[] | null;
  expiresAt: Date;
};

export async function runPlatformKeyCreate(
  projectDir: string,
  dbUrl: string,
  opts: CreatePlatformKeyOpts,
): Promise<CreatePlatformKeyResult> {
  assertEnabled(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try {
    const expiresAt = new Date(Date.now() + opts.days * 24 * 60 * 60 * 1000);
    const managedWorkspaces = opts.allWorkspaces ? null : (opts.workspaces ?? []);
    const { secret, id } = await createPlatformKey(db, {
      label: opts.label,
      managedWorkspaces,
      expiresAt,
      createdBy: "cli",
    });
    return { id, secret, managedWorkspaces, expiresAt };
  } finally {
    await db.end();
  }
}

export async function runPlatformKeyList(
  projectDir: string,
  dbUrl: string,
): Promise<PlatformKeyInfo[]> {
  assertEnabled(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try {
    return await listPlatformKeys(db);
  } finally {
    await db.end();
  }
}

export async function runPlatformKeyRevoke(
  projectDir: string,
  dbUrl: string,
  id: string,
): Promise<boolean> {
  assertEnabled(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try {
    return await revokePlatformKey(db, id);
  } finally {
    await db.end();
  }
}
