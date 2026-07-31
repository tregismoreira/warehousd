import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, chmodSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import {
  pkcePair,
  signInViaHttp,
  authorizeAndGetCode,
  exchangeCodeForToken,
} from "./helpers/oauth";
import { getClientPolicy } from "@warehousd/broker";
import { resolveProject, type Project } from "../../src/project";

const WAREHOUSD_IMAGE = process.env.WAREHOUSD_IMAGE ?? "ghcr.io/tregismoreira/warehousd:dev";
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

// `mkdtempSync` creates the directory 0700, which no real project directory is: a git clone or a
// plain `mkdir` under the usual umask lands on 0755. The difference is invisible on macOS, where
// Docker Desktop virtualises bind-mount ownership so the container user can read anything the host
// user can. On Linux a bind mount keeps the host's uid and mode, and the image runs as `node`
// (uid 1000) while a CI runner is uid 1001 — so 0700 makes /project untraversable, `loadConfig`
// finds no warehousd.yml, and the container restarts until the health check gives up 180s later.
//
// So: mode the directory like the thing it stands in for. Testing against 0700 tests a directory
// layout this project never ships.
function projectDirLike0755(): string {
  const dir = mkdtempSync(join(tmpdir(), "wh-e2e-"));
  chmodSync(dir, 0o755);
  return dir;
}

interface StackState {
  projectDir: string;
  projectName: string;
  serverPort: number;
  dbPort: number;
  // Captured from the one cold start in this suite, asserted on in Step 3b.
  firstStartStderr?: string;
  firstStartStdout?: string;
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
      throw new Error(
        `CLI dist not found at ${CLI_DIST}. Run: cd mvp && pnpm --filter warehousd build`,
      );
    }

    const serverPort = await freePort();
    const dbPort = await freePort();

    stack = {
      projectDir: projectDirLike0755(),
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

  afterAll(() => {
    try {
      // stack.ns is unset only if the run died before Step 2 wrote the config; there is
      // nothing to reap in that case because `start` never ran.
      if (stack.ns) {
        // Force cleanup: remove all containers with this project's label
        try {
          const listOut = execFileSync(
            "docker",
            ["ps", "-aq", "--filter", `label=${stack.ns.label}`],
            {
              encoding: "utf8",
            },
          );
          const containerIds = listOut
            .trim()
            .split("\n")
            .filter((id) => id);
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

  it("Step 1: init creates config files in bare temp dir", () => {
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

  it("Step 2: overwrite warehousd.yml with fixture containing offset ports and datasets", () => {
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

  it("Step 3: start creates outputs.json with exactly six keys and uses offset port", () => {
    const env = { ...process.env, WAREHOUSD_IMAGE };
    // This is the suite's only genuinely cold start — no network, no volume, no containers — so
    // it is where the first-run stderr is worth capturing rather than discarding.
    const proc = spawnSync("node", [CLI_DIST, "start"], {
      cwd: stack.projectDir,
      env,
      encoding: "utf8",
    });
    if (proc.status !== 0) {
      throw new Error(
        `start failed (${proc.status})\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
      );
    }
    stack.firstStartStderr = proc.stderr;
    stack.firstStartStdout = proc.stdout;

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

  // The regression test for the reported incident. A first `start` in examples/harbor printed
  // five Docker daemon errors — every one of them the success path of an existence probe —
  // because execFileSync echoes a child's stderr to the parent unless `stdio` says otherwise.
  // Fails without the stdio fix in src/docker.ts.
  it("Step 3b: a cold start says nothing in Docker's voice", () => {
    const stderr = stack.firstStartStderr ?? "";
    for (const noise of [
      "Error response from daemon",
      "no such object",
      "No such container",
      "not found",
      "no such volume",
    ]) {
      expect(stderr).not.toContain(noise);
    }
  });

  it("Step 3c: start narrates on stderr and leaves stdout to the summary", () => {
    const stderr = stack.firstStartStderr ?? "";
    const stdout = stack.firstStartStdout ?? "";
    // Progress is narration; the panel is the product. `start 2>/dev/null` must still be useful.
    expect(stderr).toContain("Starting");
    expect(stdout).toContain("warehousd is running");
    expect(stdout).toContain(stack.mcpUrl);
  });

  it("Step 3d: the printed summary carries no secret in plaintext", () => {
    const stdout = stack.firstStartStdout ?? "";
    expect(stack.adminPassword).toBeTruthy();
    expect(stack.devClientSecret).toBeTruthy();
    expect(stdout).not.toContain(stack.adminPassword);
    expect(stdout).not.toContain(stack.devClientSecret);
    expect(stdout).not.toContain(stack.dbPassword);
    // ...but it says how to get them.
    expect(stdout).toContain("warehousd secrets --show");
  });

  it("Step 3e: nothing piped is coloured", () => {
    const esc = String.fromCharCode(27);
    expect(stack.firstStartStdout ?? "").not.toContain(esc);
    expect(stack.firstStartStderr ?? "").not.toContain(esc);
  });

  it("Step 3f: secrets --show reveals what the summary masked, and --json is parseable", () => {
    const shown = execFileSync("node", [CLI_DIST, "secrets", "--show"], {
      cwd: stack.projectDir,
      encoding: "utf8",
    });
    expect(shown).toContain(stack.adminPassword);

    const json = JSON.parse(
      execFileSync("node", [CLI_DIST, "secrets", "--json"], {
        cwd: stack.projectDir,
        encoding: "utf8",
      }),
    );
    expect(json["Admin password"]).toBe(stack.adminPassword);
  });

  it("Step 3g: status --json is machine-readable and doctor passes on a live stack", () => {
    const statusOut = execFileSync("node", [CLI_DIST, "status", "--json"], {
      cwd: stack.projectDir,
      encoding: "utf8",
    });
    const status = JSON.parse(statusOut);
    expect(status.healthy).toBe(true);
    expect(status.project).toBe(stack.projectName.toLowerCase().replace(/-/g, "_"));
    expect(Array.isArray(status.containers)).toBe(true);

    const doctorOut = execFileSync("node", [CLI_DIST, "doctor", "--json"], {
      cwd: stack.projectDir,
      env: { ...process.env, WAREHOUSD_IMAGE },
      encoding: "utf8",
    });
    const doctor = JSON.parse(doctorOut);
    expect(doctor.ok).toBe(true);
    expect(doctor.checks.find((c: { id: string }) => c.id === "docker")?.ok).toBe(true);
    // The check that would have named the reported incident outright.
    expect(doctor.checks.find((c: { id: string }) => c.id === "image")?.detail).toContain(
      WAREHOUSD_IMAGE,
    );
  });

  it("Step 3h: an unknown command is refused with a suggestion, not silently ignored", () => {
    const proc = spawnSync("node", [CLI_DIST, "statuss"], {
      cwd: stack.projectDir,
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("statuss");
    expect(proc.stderr).toContain("status");
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
      code: code,
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
        Accept: "application/json, text/event-stream",
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

    // `tools/list` is a static listing and `list_collections` reads app.collections — both answer
    // from the app pool, so neither can tell a working stack from one whose *dev* pool was built
    // from `undefined`. That is exactly how a container which never received DEV_DATABASE_URL kept
    // this suite green while every governed query in it pointed at libpq's defaults.
    //
    // Only a successful query_collection reaches data_synth through the warehousd_dev role, and
    // only an approved grant gets there — so grant first, then query.
    const grantDb = new Pool({ connectionString: stack.databaseUrl });
    const adminId = await grantDb.query<{ id: string }>(
      `select id from app."user" where email = $1`,
      [stack.adminEmail],
    );
    await grantDb.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ($1, 'dataset_col', $2, 'dev', 'approved')`,
      [adminId.rows[0]?.id, ["id", "name"]],
    );
    await grantDb.end();

    const queryRes = await fetch(stack.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "query_collection",
          arguments: { collection: "dataset_col", fields: ["id", "name"], limit: 1 },
        },
      }),
    });

    expect(queryRes.ok).toBe(true);
    const queryBody = await queryRes.text();
    // A dev pool that cannot connect refuses with internal_error — which is exactly what this
    // returned before the role URLs were derived server-side. Success has to be asserted on the
    // payload, not on the HTTP status: the transport is 200 either way.
    expect(queryBody).not.toMatch(/internal_error/i);
    expect(queryBody).toContain('\\"ok\\":true');
    expect(queryBody).toContain("documents");
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
      const columnNames = viewColumns.rows.map((row) => row.column_name);
      expect(columnNames).toContain("name");
      expect(columnNames).toContain("id");

      // Verify the client policy still references the dataset
      const policy = await db.query(
        `
        select 1 from app.client_policies where client_id=$1
      `,
        [initialClientId],
      );
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
