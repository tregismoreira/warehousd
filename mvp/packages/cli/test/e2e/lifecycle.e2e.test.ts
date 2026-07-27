import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { pkcePair, signInViaHttp, authorizeAndGetCode, exchangeCodeForToken } from "./helpers/oauth";
import { getClientPolicy } from "@warehousd/broker";
import { resolveProject, type Project } from "../../src/project";

const WAREHOUSD_IMAGE = process.env.WAREHOUSD_IMAGE ?? "ghcr.io/warehousd/warehousd:dev";
const CLI_DIST = new URL("../../dist/index.cjs", import.meta.url).pathname;

// Ports are probed per run, never hardcoded. A container leaked by an earlier run holds
// its published port for as long as it exists, so a fixed pair turns one leak into a
// permanent outage of this suite — every subsequent `start` dies on "port is already
// allocated" before a single assertion about the CLI runs.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface StackState {
  projectDir: string;
  projectName: string;
  serverPort: number;
  dbPort: number;
  // Docker object names, taken from the CLI's own resolveProject rather than rebuilt
  // here. cfg.project is sanitised before it reaches Docker (src/project.ts), so any
  // name derived independently in this file silently stops matching what `start`
  // created — which is exactly how teardown came to remove nothing at all.
  ns?: Project["ns"];
  apiUrl: string;
  mcpUrl: string;
  databaseUrl: string;
  adminEmail: string;
  adminPassword: string;
  dbPassword: string;
  devClientId: string;
  devClientSecret: string;
  initialRowCount?: number;
}

let stack: StackState;

describe("CLI Docker Lifecycle E2E", () => {
  beforeAll(async () => {
    // Pre-check: ensure CLI dist exists
    if (!existsSync(CLI_DIST)) {
      throw new Error(`CLI dist not found at ${CLI_DIST}. Run: cd mvp && pnpm --filter warehousd build`);
    }

    const serverPort = await freePort();
    const dbPort = await freePort();

    stack = {
      projectDir: mkdtempSync(join(tmpdir(), "wh-e2e-")),
      projectName: `wh-e2e-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      serverPort,
      dbPort,
      apiUrl: `http://localhost:${serverPort}`,
      mcpUrl: `http://localhost:${serverPort}/mcp`,
      databaseUrl: "", // Will be updated after start reads the password
      adminEmail: "admin@warehousd.local",
      adminPassword: "", // Will be read from outputs.json after start
      dbPassword: "", // Will be read from state.json after start
      devClientId: "",
      devClientSecret: "",
    };
  });

  afterAll(async () => {
    try {
      // stack.ns is unset only if the run died before Step 2 wrote the config; there is
      // nothing to reap in that case because `start` never ran.
      if (stack.ns) {
        // Force cleanup: remove all containers with this project's label
        try {
          const listOut = execFileSync("docker", ["ps", "-aq", "--filter", `label=${stack.ns.label}`], {
            encoding: "utf8",
          });
          const containerIds = listOut.trim().split("\n").filter((id) => id);
          for (const id of containerIds) {
            try {
              execFileSync("docker", ["rm", "-f", id], { stdio: "pipe" });
            } catch {
              // Ignore individual removal failures
            }
          }
        } catch {
          // Ignore if docker ps fails
        }

        // Remove volume
        try {
          execFileSync("docker", ["volume", "rm", "-f", stack.ns.volume], { stdio: "pipe" });
        } catch {
          // Ignore if volume doesn't exist
        }

        // Remove network
        try {
          execFileSync("docker", ["network", "rm", stack.ns.net], { stdio: "pipe" });
        } catch {
          // Ignore if network doesn't exist
        }
      }

      // Remove temp directory
      rmSync(stack.projectDir, { recursive: true, force: true });
    } catch (err) {
      console.error("Cleanup error (non-fatal):", err);
    }
  });

  it("Step 1: init creates config files in bare temp dir", async () => {
    execFileSync("node", [CLI_DIST, "init"], { cwd: stack.projectDir, stdio: "pipe" });

    const warehousdYml = join(stack.projectDir, "warehousd.yml");
    const gitignore = join(stack.projectDir, ".gitignore");

    expect(existsSync(warehousdYml)).toBe(true);
    expect(existsSync(gitignore)).toBe(true);

    // Verify we can read and parse the config
    const content = readFileSync(warehousdYml, "utf8");
    expect(content).toContain("project:");
    expect(content).toContain("server:");
    expect(content).toContain("collections:");
  });

  it("Step 2: overwrite warehousd.yml with fixture containing offset ports and datasets", async () => {
    const fixtureYaml = `
project: ${stack.projectName}
server:
  port: ${stack.serverPort}
  image: ${WAREHOUSD_IMAGE}
database:
  port: ${stack.dbPort}
collections:
  dataset_col:
    description: A dataset collection
    fields:
      id:
        type: uuid
        pk: true
        posture: allow
      name:
        type: text
        posture: allow
  file_col:
    type: file
    description: File collection with documents
    source: ./docs-dev
    fields:
      title:
        posture: allow
      content:
        posture: allow
      path:
        posture: deny
taxonomies:
  sample_taxonomy:
    label: Sample Taxonomy
    terms:
      category-a:
        label: Category A
      category-b:
        label: Category B
`;
    writeFileSync(join(stack.projectDir, "warehousd.yml"), fixtureYaml);

    // Create docs directory with sample markdown files
    const docsDir = join(stack.projectDir, "docs-dev");
    execFileSync("mkdir", ["-p", docsDir], { stdio: "pipe" });
    writeFileSync(join(docsDir, "doc1.md"), "# Document 1\n\nContent of doc 1");
    writeFileSync(join(docsDir, "doc2.md"), "# Document 2\n\nContent of doc 2");

    // Now that the config exists, ask the CLI itself what it will name every Docker
    // object. Teardown and the Step 8/9 assertions all key off this.
    stack.ns = resolveProject(stack.projectDir).ns;
  });

  it("Step 3: start creates outputs.json with exactly six keys and uses offset port", async () => {
    const env = { ...process.env, WAREHOUSD_IMAGE };
    execFileSync("node", [CLI_DIST, "start"], { cwd: stack.projectDir, env, stdio: "pipe" });

    const outputsPath = join(stack.projectDir, ".warehousd", "outputs.json");
    expect(existsSync(outputsPath)).toBe(true);

    const outputs = JSON.parse(readFileSync(outputsPath, "utf8"));

    // Check exactly six keys exist (no more, no less)
    const outputKeys = Object.keys(outputs).sort();
    const expectedKeys = ["adminUrl", "apiUrl", "databaseUrl", "devClient", "env", "mcpUrl"].sort();
    expect(outputKeys).toEqual(expectedKeys);

    expect(outputs.env).toBe("dev");
    expect(outputs.mcpUrl).toContain(String(stack.serverPort));
    expect(outputs.apiUrl).toContain(String(stack.serverPort));
    expect(outputs.adminUrl).toContain(String(stack.serverPort));
    expect(outputs.databaseUrl).toContain(String(stack.dbPort));

    // Extract credentials for later use
    stack.devClientId = outputs.devClient.clientId;
    stack.devClientSecret = outputs.devClient.clientSecret;

    // Extract admin password and db password from state.json. Missing state.json means
    // `start` did not complete — fail here rather than leaving databaseUrl empty, which
    // makes pg fall back to libpq defaults and resurface two steps later as a confusing
    // `database "<your-username>" does not exist`.
    const statePath = join(stack.projectDir, ".warehousd", "state.json");
    if (!existsSync(statePath)) throw new Error(`start did not write ${statePath}`);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    stack.adminPassword = state.adminPassword;
    stack.dbPassword = state.dbPassword;
    stack.databaseUrl = `postgres://warehousd:${state.dbPassword}@localhost:${stack.dbPort}/warehousd`;
  });

  it("Step 4: health endpoints respond correctly", async () => {
    const healthRes = await fetch(`${stack.apiUrl}/api/health`);
    expect(healthRes.status).toBe(200);

    const mcpRes = await fetch(stack.mcpUrl);
    expect(mcpRes.status).toBe(401);
  });

  it("Step 5: database contains synthetic data and dev client policy", async () => {
    const db = new Pool({ connectionString: stack.databaseUrl });

    try {
      // Check dataset collection has rows
      const datasetRows = await db.query(`
        select count(*) as cnt from data_synth."dataset_col"
      `);
      expect(Number(datasetRows.rows[0].cnt)).toBeGreaterThan(0);

      // Check file collection has rows in __files table
      const filesRows = await db.query(`
        select count(*) as cnt from data_synth."file_col__files"
      `);
      expect(Number(filesRows.rows[0].cnt)).toBeGreaterThanOrEqual(2);

      // Check file collection has rows in __documents table
      const docsRows = await db.query(`
        select count(*) as cnt from data_synth."file_col__documents"
      `);
      expect(Number(docsRows.rows[0].cnt)).toBeGreaterThanOrEqual(2);

      // Check dev client policy
      const policy = await getClientPolicy(db, stack.devClientId);
      expect(policy.allowedScopes).toEqual(["env:dev"]);
    } finally {
      await db.end();
    }
  });

  it("Step 6: dev client token mint via OAuth flow using provisioned devClient", async () => {
    // Sign in as admin
    const cookie = await signInViaHttp(stack.apiUrl, stack.adminEmail, stack.adminPassword);
    expect(cookie).toBeTruthy();

    // Use the devClient that was provisioned during startup (with redirect_uri pre-registered)
    expect(stack.devClientId).toBeTruthy();
    expect(stack.devClientSecret).toBeTruthy();

    // Generate PKCE pair
    const { verifier, challenge } = pkcePair();

    // Get authorization code using the actual devClient
    const { code, location } = await authorizeAndGetCode(stack.apiUrl, {
      clientId: stack.devClientId,
      redirectUri: "http://localhost/callback",
      scope: "env:dev",
      cookie,
      challenge,
    });

    if (!code) {
      throw new Error(`Authorization failed: location=${location}`);
    }
    expect(code).toBeTruthy();
    expect(location).toContain("code=");

    // Exchange code for token using the actual devClient credentials
    const { access_token, scope } = await exchangeCodeForToken(stack.apiUrl, {
      clientId: stack.devClientId,
      clientSecret: stack.devClientSecret,
      code: code!,
      verifier,
      redirectUri: "http://localhost/callback",
    });

    expect(access_token).toBeTruthy();
    expect(scope).toContain("env:dev");
    expect(scope).not.toContain("env:live");

    // Verify token works with MCP
    const mcpRes = await fetch(stack.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    if (!mcpRes.ok) {
      const text = await mcpRes.text();
      throw new Error(`MCP call failed: ${mcpRes.status} ${text}`);
    }
    // MCP response is server-sent events (SSE), just verify the response is ok
    const body = await mcpRes.text();
    expect(body).toBeTruthy();
    // Response should contain MCP event data
    expect(body).toMatch(/event:|data:/);
  });

  it("Step 7: YAML change re-applies without changing devClient", async () => {
    // Record initial dev client ID
    const initialClientId = stack.devClientId;
    const initialClientSecret = stack.devClientSecret;

    // Add a new dataset and flip a field posture
    const updatedYaml = `
project: ${stack.projectName}
server:
  port: ${stack.serverPort}
  image: ${WAREHOUSD_IMAGE}
database:
  port: ${stack.dbPort}
collections:
  dataset_col:
    description: A dataset collection
    fields:
      id:
        type: uuid
        pk: true
        posture: allow
      name:
        type: text
        posture: deny
  new_dataset_col:
    description: New dataset collection
    fields:
      id:
        type: uuid
        pk: true
        posture: allow
      value:
        type: text
        posture: allow
  file_col:
    type: file
    description: File collection with documents
    source: ./docs-dev
    fields:
      title:
        posture: allow
      content:
        posture: allow
      path:
        posture: deny
taxonomies:
  sample_taxonomy:
    label: Sample Taxonomy
    terms:
      category-a:
        label: Category A
      category-b:
        label: Category B
`;
    writeFileSync(join(stack.projectDir, "warehousd.yml"), updatedYaml);

    // Run start again
    const env = { ...process.env, WAREHOUSD_IMAGE };
    execFileSync("node", [CLI_DIST, "start"], { cwd: stack.projectDir, env, stdio: "pipe" });

    // Verify new dataset exists with data
    const db = new Pool({ connectionString: stack.databaseUrl });
    try {
      const newDataRows = await db.query(`
        select count(*) as cnt from data_synth."new_dataset_col"
      `);
      expect(Number(newDataRows.rows[0].cnt)).toBeGreaterThan(0);

      // v_<collection> is a flat projection of every YAML field regardless of posture
      // (apply/ddl.ts:71-83). Posture is enforced at the grant/query layer, not in the
      // view: broker.ts:43-44 refuses ungranted fields, and document_filter deliberately
      // resolves against the full field set so deny fields like `path` can gate documents
      // (broker.ts:45-48). Asserting the column is still present pins that design.
      const viewColumns = await db.query(`
        select column_name
        from information_schema.columns
        where table_schema = 'data_synth' and table_name = 'v_dataset_col'
        order by column_name
      `);
      const columnNames = viewColumns.rows.map(row => row.column_name);
      expect(columnNames).toContain("name");
      expect(columnNames).toContain("id");

      // Verify the client policy still references the dataset
      const policy = await db.query(`
        select 1 from app.client_policies where client_id=$1
      `, [initialClientId]);
      expect(policy.rowCount).toBe(1);
    } finally {
      await db.end();
    }

    // Verify devClient unchanged in outputs
    const outputsPath = join(stack.projectDir, ".warehousd", "outputs.json");
    const outputs = JSON.parse(readFileSync(outputsPath, "utf8"));
    expect(outputs.devClient.clientId).toBe(initialClientId);
    expect(outputs.devClient.clientSecret).toBe(initialClientSecret);
  });

  it("Step 8: stop keeps data and volume intact", async () => {
    // Record initial row count
    let db = new Pool({ connectionString: stack.databaseUrl });
    const initialCount = await db.query(`
      select count(*) as cnt from data_synth."dataset_col"
    `);
    const rowCount = Number(initialCount.rows[0].cnt);
    expect(rowCount).toBeGreaterThan(0);
    stack.initialRowCount = rowCount;
    await db.end();

    // Stop the stack
    execFileSync("node", [CLI_DIST, "stop"], { cwd: stack.projectDir, stdio: "pipe" });

    // Verify containers are gone. `-q` prints ids only — no header row — so an empty
    // result genuinely means "nothing left", unlike `docker ps -a` whose header makes
    // the output non-empty forever.
    let remaining = "unchecked";
    for (let attempts = 0; attempts < 10; attempts++) {
      remaining = execFileSync("docker", ["ps", "-aq", "--filter", `label=${stack.ns!.label}`], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      if (!remaining) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(remaining).toBe("");

    // Verify volume still exists (can't directly query it, but start should work)
    // Start again to verify volume reuse
    const env = { ...process.env, WAREHOUSD_IMAGE };
    execFileSync("node", [CLI_DIST, "start"], { cwd: stack.projectDir, env, stdio: "pipe" });

    // Verify row count unchanged
    db = new Pool({ connectionString: stack.databaseUrl });
    const finalCount = await db.query(`
      select count(*) as cnt from data_synth."dataset_col"
    `);
    const finalRowCount = Number(finalCount.rows[0].cnt);
    expect(finalRowCount).toBe(rowCount);
    await db.end();
  });

  it("Step 9: destroy removes volume and outputs but keeps state", async () => {
    // Run destroy
    execFileSync("node", [CLI_DIST, "stop", "--destroy", "--yes"], {
      cwd: stack.projectDir,
      stdio: "pipe",
    });

    // Verify outputs.json is gone
    const outputsPath = join(stack.projectDir, ".warehousd", "outputs.json");
    expect(existsSync(outputsPath)).toBe(false);

    // Verify state.json still exists
    const statePath = join(stack.projectDir, ".warehousd", "state.json");
    expect(existsSync(statePath)).toBe(true);

    // Verify volume is gone. This must inspect the name the CLI actually created
    // (stack.ns.volume) — inspecting a name that never existed "passes" unconditionally
    // and asserts nothing about --destroy.
    let volumeExists = true;
    for (let attempts = 0; attempts < 10; attempts++) {
      try {
        execFileSync("docker", ["volume", "inspect", stack.ns!.volume], { stdio: "pipe" });
        volumeExists = true;
      } catch {
        volumeExists = false;
      }
      if (!volumeExists) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(volumeExists).toBe(false);
  });
});
