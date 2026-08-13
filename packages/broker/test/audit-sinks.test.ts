import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { auditSinks, AUDIT_SINK_IDS, auditSink } from "../src/audit/sinks";
import { makeCtx } from "./helpers/ctx";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// §P8. `writeAudit` inserted into app.audit_events and nowhere else, and `audit.enabled` was a
// boolean — so a deployment that had to forward its trail to a SIEM had no way to say so.
//
// The property that must survive a pluggable destination is the one that makes the trail worth
// having: an allow whose decision could not be recorded is not an allow.

const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned, app: Pool;

const base = {
  project: "test",
  collections: {
    people: {
      description: "People",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: "allow" },
      },
    },
  },
};

function cfgWith(audit: Record<string, unknown>): WarehousdConfig {
  return ConfigSchema.parse({ ...base, audit });
}

beforeAll(async () => {
  p = await provision("audit-sinks");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfgWith({ enabled: true }));
  await app.query(
    `insert into data_synth.people (${R}, workspace_id, id, email)
     values (${RV}, 'default', gen_random_uuid(), 'seed@ex.com')`,
  );
}, 60_000);

afterAll(async () => {
  await app.end();
  await p.end();
});

async function grantFor(userId: string, cfg: WarehousdConfig) {
  const id = await requestGrant(app, {
    userId,
    collection: "people",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "t",
    allowedFields: ["id", "email"],
  });
  const r = await approveGrant(app, cfg, id, "boss", { allowedFields: ["id", "email"] });
  if (!r.ok) throw new Error(r.error);
}

describe("the registry", () => {
  it("registers every declared id, and each entry knows its own", () => {
    expect(Object.keys(auditSinks).sort()).toEqual([...AUDIT_SINK_IDS].sort());
    for (const [id, sink] of Object.entries(auditSinks)) expect(sink.id).toBe(id);
  });

  it("defaults to postgres — the destination every deployment had before sinks existed", () => {
    expect(auditSink(undefined).id).toBe("postgres");
  });
});

describe("config", () => {
  it("refuses a webhook sink with no url", () => {
    const r = ConfigSchema.safeParse({ ...base, audit: { sink: "webhook" } });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("requires `audit.url`");
  });

  it("refuses a url on a sink that makes no request", () => {
    const r = ConfigSchema.safeParse({
      ...base,
      audit: { sink: "postgres", url: "https://x.example" },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("takes neither");
  });

  it("defaults to postgres when the block only turns auditing on", () => {
    expect(ConfigSchema.parse({ ...base, audit: { enabled: true } }).audit.sink).toBe("postgres");
  });

  it("refuses a timeout on a sink that makes no request", () => {
    const r = ConfigSchema.safeParse({
      ...base,
      audit: { sink: "stdout-json", timeout_ms: 1000 },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("configures nothing");
  });
});

describe("stdout-json", () => {
  it("writes one JSON object per decision and returns its id", async () => {
    const cfg = cfgWith({ enabled: true, sink: "stdout-json" });
    const pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const broker = makeBroker(pools, cfg);
    await grantFor("stdout_user", cfg);

    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
      written.push(String(s));
      return true;
    }) as typeof process.stdout.write);
    try {
      const res = await broker.query(makeCtx({ userId: "stdout_user" }), { collection: "people" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      const line = written.find((l) => l.includes("warehousd.audit"));
      expect(line).toBeDefined();
      const event = JSON.parse(line!) as { id: string; outcome: string; collection: string };
      // The id the caller was handed is the id in the log line: correlating a response with the
      // decision that produced it is the whole point of returning one.
      expect(event.id).toBe(res.auditId);
      expect(event).toMatchObject({ outcome: "allowed", collection: "people" });
    } finally {
      spy.mockRestore();
      await pools.end();
    }
  });

  it("does not write a row to app.audit_events", async () => {
    const before = await app.query<{ n: string }>(
      `select count(*)::text as n from app.audit_events where user_id='stdout_only'`,
    );
    const cfg = cfgWith({ enabled: true, sink: "stdout-json" });
    const pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const broker = makeBroker(pools, cfg);
    await grantFor("stdout_only", cfg);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await broker.query(makeCtx({ userId: "stdout_only" }), { collection: "people" });
    } finally {
      spy.mockRestore();
      await pools.end();
    }
    const after = await app.query<{ n: string }>(
      `select count(*)::text as n from app.audit_events where user_id='stdout_only'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe("webhook", () => {
  const cfg = cfgWith({ enabled: true, sink: "webhook", url: "https://collector.example/audit" });

  it("posts the decision and returns the id it posted", async () => {
    const pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const broker = makeBroker(pools, cfg);
    await grantFor("hook_user", cfg);

    const calls: { url: string; body: unknown }[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      // The sink always passes a string url and a string body; both are `unknown`-ish to the
      // compiler because `fetch` accepts more than the sink sends.
      const body = typeof init?.body === "string" ? init.body : "null";
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: href, body: JSON.parse(body) });
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    try {
      const res = await broker.query(makeCtx({ userId: "hook_user" }), { collection: "people" });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      expect(calls[0]?.url).toBe("https://collector.example/audit");
      expect(calls[0]?.body).toMatchObject({
        type: "warehousd.audit",
        id: res.auditId,
        outcome: "allowed",
      });
    } finally {
      spy.mockRestore();
      await pools.end();
    }
  });

  // The rule the whole feature has to preserve: a decision that could not be recorded is not an
  // allow. A sink that swallowed its own failure would turn the guarantee into a hope.
  it("downgrades an allow to internal_error when the collector refuses", async () => {
    const pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const broker = makeBroker(pools, cfg);
    await grantFor("hook_down", cfg);

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await broker.query(makeCtx({ userId: "hook_down" }), { collection: "people" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("internal_error");
      expect(res.auditId).toBeNull();
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
      await pools.end();
    }
  });

  it("still refuses — with the reason — when the collector is down on a refusal path", async () => {
    const pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const broker = makeBroker(pools, cfg);
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.reject(new Error("network")));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A refusal stands whether or not the row was written — there is nothing to withhold.
      const res = await broker.query(makeCtx({ userId: "nobody_at_all" }), {
        collection: "people",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("no_grant");
      expect(res.auditId).toBeNull();
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
      await pools.end();
    }
  });

  // The sink is synchronous with the decision on purpose, which is only survivable if the wait is
  // bounded. A collector that accepts the connection and then goes quiet must not be able to hold
  // the request path open — and giving up must count as a FAILED write, not a silent success.
  describe("a hung collector", () => {
    const quick = cfgWith({
      enabled: true,
      sink: "webhook",
      url: "https://collector.example/audit",
      timeout_ms: 50,
    });

    it("passes the configured deadline to fetch as an abort signal", async () => {
      const pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
      const broker = makeBroker(pools, quick);
      await grantFor("hook_deadline", quick);

      const signals: (AbortSignal | null | undefined)[] = [];
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        signals.push(init?.signal);
        return Promise.resolve(new Response(null, { status: 202 }));
      });
      try {
        expect(
          (await broker.query(makeCtx({ userId: "hook_deadline" }), { collection: "people" })).ok,
        ).toBe(true);
        // Not merely present: an AbortSignal that nothing ever fires is a timeout in name only.
        expect(signals[0]).toBeInstanceOf(AbortSignal);
        expect(signals[0]?.aborted).toBe(false);
      } finally {
        spy.mockRestore();
        await pools.end();
      }
    });

    it("downgrades an allow to a refusal rather than waiting, and never silently succeeds", async () => {
      const pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
      const broker = makeBroker(pools, quick);
      await grantFor("hook_hung", quick);

      // A collector that answers only when the signal aborts — the shape of a real hang, rather
      // than a rejection the sink would have caught anyway.
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              // The real `fetch` rejects with the signal's reason, which is a `TimeoutError`
              // DOMException — an Error, but not one the lint rule can see through `unknown`.
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new Error("aborted with a non-Error reason"),
              ),
            );
          }),
      );
      const logged: unknown[][] = [];
      const quiet = vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a));
      try {
        const started = Date.now();
        const res = await broker.query(makeCtx({ userId: "hook_hung" }), { collection: "people" });
        // Refused, not allowed, and not still running.
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe("internal_error");
        expect(res.auditId).toBeNull();
        expect(Date.now() - started).toBeLessThan(5_000);
        // Loud for the operator — and about the deadline, not about the data.
        const text = JSON.stringify(logged);
        expect(text).toContain("timed out");
        expect(text).not.toContain("seed@ex.com");
      } finally {
        spy.mockRestore();
        quiet.mockRestore();
        await pools.end();
      }
    });
  });
});
