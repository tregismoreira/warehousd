import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { PROVISIONABLE_DB_PROVIDER_IDS } from "@warehousd/broker";
import { dbHosts, hostFor, hostsMatchProviders, localHosts } from "../src/db/hosts";
import { connectionUri, projectId } from "../src/neon";

vi.mock("node:child_process");

const mocked = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

/** Route each invocation by its first argument, the way the railway suite already does. */
function onSubcommand(handlers: Record<string, (args: string[]) => string>): void {
  mocked.mockImplementation((_bin, args) => {
    const argv = (args as string[]) ?? [];
    const key = argv.slice(0, 2).join(" ");
    const handler = handlers[key] ?? handlers[argv[0] ?? ""];
    if (!handler) return "";
    return handler(argv);
  });
}

const ctx = {
  projectDir: "/tmp/project",
  appName: "harbor",
  region: "sa-east-1",
  org: undefined,
  say: () => {},
};

describe("the registry", () => {
  // The half `satisfies` cannot prove. The broker's `provisions` flags are what DeploySchema
  // refuses `managed` + `provider: generic` against, so a flag with no host would promise a
  // capability that does not exist, and a host with no flag would be unreachable from config.
  it("implements exactly the providers the broker declares provisionable", () => {
    expect(hostsMatchProviders()).toBe(true);
    expect(Object.keys(dbHosts).sort()).toEqual([...PROVISIONABLE_DB_PROVIDER_IDS].sort());
  });

  it("does not offer a host for a provider that has no CLI, or one the target already builds", () => {
    expect(hostFor("generic")).toBeUndefined();
    expect(hostFor("railway")).toBeUndefined();
  });

  // Neon is a hosted service with no local mode, so the init wizard must not offer it as a local
  // option and `database.provider: neon` has to be refused with that sentence.
  it("knows which hosts can run locally", () => {
    expect(localHosts().map((h) => h.id)).toEqual(["supabase"]);
    expect(hostFor("neon")?.local).toBeUndefined();
  });
});

describe("neon", () => {
  const host = hostFor("neon")!;

  it("refuses to provision without a region, naming Neon's own codes", async () => {
    const checks = await host.preflight({
      projectDir: "/tmp",
      env: { PATH: "" },
      region: undefined,
      org: undefined,
    });
    const region = checks.find((c) => c.id === "neon-region");
    expect(region?.ok).toBe(false);
    expect(region?.detail).toContain("aws-us-east-1");
  });

  it("creates a project and takes the connection string the CLI hands back", async () => {
    onSubcommand({
      "projects create": () =>
        JSON.stringify({
          id: "cool-project-123",
          connection_uris: [{ connection_uri: "postgresql://o:p@ep-x.aws.neon.tech/neondb" }],
        }),
    });

    const created = await host.provision(ctx);

    expect(created.ref).toBe("cool-project-123");
    // Appended so a warehousd-created project passes the broker's own Neon advisory on the first
    // run rather than tripping it.
    expect(created.url).toContain("sslmode=require");

    const argv = mocked.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(argv[0]).toContain("projects create --name harbor-warehousd-");
    expect(argv[0]).toContain("--region-id sa-east-1");
  });

  // A project created but unreadable is the case where guessing is worst: a wrong URL would send
  // governed data to somebody else's database.
  it("refuses rather than guessing when the JSON has no connection string", () => {
    onSubcommand({ "projects create": () => JSON.stringify({ id: "x" }) });
    expect(() => host.provision(ctx)).toThrow(/could not read its connection string/);
  });

  it("deletes the project it recorded", async () => {
    onSubcommand({ "projects delete": () => "" });
    await host.destroy(ctx, { provider: "neon", ref: "cool-project-123", createdAt: "now" });
    expect(mocked.mock.calls.map((c) => (c[1] as string[]).join(" "))).toContain(
      "projects delete cool-project-123",
    );
  });
});

// Tolerance for a CLI whose output has moved across versions — the same property railway.ts's
// `linkedProject` has, for the same reason.
describe("neon json shapes", () => {
  it("reads the connection uri from every shape the CLI has printed", () => {
    expect(connectionUri('{"connection_uri":"postgres://a"}')).toBe("postgres://a");
    expect(connectionUri('{"connection_uris":["postgres://b"]}')).toBe("postgres://b");
    expect(connectionUri('{"connection_uris":[{"connection_uri":"postgres://c"}]}')).toBe(
      "postgres://c",
    );
    expect(
      connectionUri('{"project":{"connection_uris":[{"connection_uri":"postgres://d"}]}}'),
    ).toBe("postgres://d");
  });

  it("is undefined rather than throwing on something it cannot read", () => {
    expect(connectionUri("not json")).toBeUndefined();
    expect(projectId("{}")).toBeUndefined();
  });
});

describe("supabase", () => {
  const host = hostFor("supabase")!;

  it("builds the session-pooler url on 5432, never the transaction pooler", async () => {
    onSubcommand({
      "projects create": () => "Created project harbor abcdefghijklmnopqrst",
      "orgs list": () => JSON.stringify([{ id: "org_1", name: "Acme" }]),
    });

    const created = await host.provision(ctx);

    expect(created.ref).toBe("abcdefghijklmnopqrst");
    // The broker's own supabase provider refuses :6543 because the transaction pooler drops the
    // three connection startup parameters warehousd sets. Building one here would create a
    // database that its own pre-flight rejects.
    expect(created.url).not.toContain("6543");
    expect(created.url).toContain(":5432/postgres");
    // Supavisor routes by username, which is what roleUsername in the broker already spells for
    // the four warehousd roles.
    expect(created.url).toContain("postgres.abcdefghijklmnopqrst:");
    expect(created.url).toContain("aws-0-sa-east-1.pooler.supabase.com");
  });

  // The password is generated by warehousd and is the only copy that will ever exist, so it has
  // to come back for state.json to record.
  it("returns the password it generated, because nothing can read it back later", async () => {
    onSubcommand({
      "projects create": () => "Created project abcdefghijklmnopqrst",
      "orgs list": () => JSON.stringify([{ id: "org_1", name: "Acme" }]),
    });
    const created = await host.provision(ctx);
    expect(created.password).toMatch(/^[0-9a-f]{48}$/);
    expect(created.url).toContain(created.password!);
  });

  it("refuses to pick between organisations rather than choosing one", () => {
    onSubcommand({
      "orgs list": () =>
        JSON.stringify([
          { id: "org_1", name: "A" },
          { id: "org_2", name: "B" },
        ]),
    });
    expect(() => host.provision(ctx)).toThrow(/Set deploy\.database\.org to one of/);
  });

  // The password is not recoverable, so this is the one failure that has to say what to do rather
  // than imply something can be retried.
  it("says how to recover when state.json has no password for the saved project", () => {
    expect(() =>
      host.reconnect(ctx, { provider: "supabase", ref: "abcdefghijklmnopqrst", createdAt: "now" }),
    ).toThrow(/Reset it in the dashboard/);
  });
});

describe("secret handling", () => {
  // AGENTS.md: secret material must not reach a trace. `projects create --db-password` puts one in
  // argv with no stdin alternative, so the containment is the redaction — and --verbose must not
  // be a way around it.
  it("keeps the generated password out of the trace and out of the failure", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const { setVerbose } = await import("../src/verbose");
    setVerbose(true);
    onSubcommand({
      "orgs list": () => JSON.stringify([{ id: "org_1", name: "Acme" }]),
      "projects create": () => {
        throw Object.assign(new Error("rejected"), {
          stderr: "could not create project with password deadbeef",
        });
      },
    });

    expect(() => hostFor("supabase")!.provision(ctx)).toThrow(
      /Failed to create the Supabase project/,
    );

    const trace = written.join("");
    expect(trace).toContain("--db-password ***");
    expect(trace).not.toMatch(/--db-password [0-9a-f]{48}/);
    // The provider echoes back what it would not accept, so its stderr can carry the value too.
    expect(trace).not.toContain("deadbeef");

    setVerbose(false);
    spy.mockRestore();
  });
});
