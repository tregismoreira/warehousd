import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, envRefs } from "../src/config/load";
import { readPosture, ConfigSchema } from "../src/config/schema";
import { DEPLOY_TARGET_IDS } from "../src/config/targets";
import { CONTAINER_RUNTIME_IDS, DEFAULT_CONTAINER_RUNTIME_ID } from "../src/config/runtimes";
import { PROVISIONABLE_DB_PROVIDER_IDS } from "../src/db/providers";
import { must } from "./helpers/must";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = `
project: cortex
server: { port: 8722 }
collections:
  people:
    description: Employee directory
    fields:
      id: { type: uuid, posture: allow, pk: true }
      email: { type: text, posture: allow }
      home_address: { type: text, posture: deny }
synthetic:
  documents_per_collection: { people: 40 }
`;

it("parses base config", () => {
  writeFileSync(join(dir, "warehousd.yml"), base);
  const cfg = loadConfig(dir);
  expect(cfg.project).toBe("cortex");
  expect(
    readPosture(must(cfg.collections.people?.fields.home_address, "the home_address field")),
  ).toBe("deny");
  expect(cfg.collections.people!.fields.id!.pk).toBe(true);
});

it("deep-merges warehousd.local.yml over base", () => {
  writeFileSync(join(dir, "warehousd.yml"), base);
  writeFileSync(join(dir, "warehousd.local.yml"), `server: { port: 9999 }`);
  const cfg = loadConfig(dir);
  expect(cfg.server.port).toBe(9999);
  expect(cfg.collections.people!.description).toBe("Employee directory");
});

it("interpolates ${env:VAR}", () => {
  process.env.WH_TEST_PORT = "7000";
  writeFileSync(
    join(dir, "warehousd.yml"),
    base.replace("port: 8722", "port: ${env:WH_TEST_PORT}"),
  );
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  const cfg = loadConfig(dir);
  expect(cfg.server.port).toBe(7000);
});

it("skips interpolation inside YAML comment lines", () => {
  writeFileSync(
    join(dir, "warehousd.yml"),
    base + "\n# This line contains ${env:UNDEFINED_VAR} in a comment",
  );
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  // Should not throw even though UNDEFINED_VAR is not set
  const cfg = loadConfig(dir);
  expect(cfg.project).toBe("cortex");
});

it("skips interpolation inside a trailing inline comment on a real line", () => {
  process.env.WH_TEST_PORT2 = "7001";
  const yml = `
project: cortex
server:
  port: \${env:WH_TEST_PORT2}  # alternative: \${env:UNDEFINED_VAR2}
collections:
  people:
    description: Employee directory
    fields:
      id: { type: uuid, posture: allow, pk: true }
      email: { type: text, posture: allow }
      home_address: { type: text, posture: deny }
synthetic:
  documents_per_collection: { people: 40 }
`;
  writeFileSync(join(dir, "warehousd.yml"), yml);
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  const cfg = loadConfig(dir);
  expect(cfg.server.port).toBe(7001);
});

it("rejects a field with an unknown posture", () => {
  writeFileSync(join(dir, "warehousd.yml"), base.replace("posture: deny", "posture: sometimes"));
  rmSync(join(dir, "warehousd.local.yml"), { force: true });
  expect(() => loadConfig(dir)).toThrow();
});
const baseSchema = { project: "t", collections: {} as Record<string, unknown> };
const doc = (over: object = {}) => ({
  type: "file",
  description: "d",
  source: "./docs",
  fields: { title: { posture: "allow" }, content: { posture: "allow" }, path: { posture: "deny" } },
  ...over,
});

describe("file collection config", () => {
  it("accepts a valid file collection and fills canonical field types", () => {
    const cfg = ConfigSchema.parse({ ...baseSchema, collections: { policies: doc() } });
    const c = cfg.collections.policies!;
    expect(c.type).toBe("file");
    expect(c.fields.title!.type).toBe("text");
  });
  it("defaults type to dataset", () => {
    const cfg = ConfigSchema.parse({
      ...baseSchema,
      collections: {
        people: {
          description: "d",
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    });
    expect(cfg.collections.people!.type).toBe("dataset");
  });
  it("rejects a file collection without source", () => {
    expect(() =>
      ConfigSchema.parse({ ...baseSchema, collections: { policies: doc({ source: undefined }) } }),
    ).toThrow();
  });
  it("rejects a field outside the fixed set", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseSchema,
        collections: {
          policies: doc({
            fields: { titl: { posture: "allow" } },
          }),
        },
      }),
    ).toThrow(/titl/);
  });
  it("rejects any collection name containing __", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseSchema,
        collections: {
          people__docs: {
            description: "d",
            fields: { id: { type: "uuid", posture: "allow" } },
          },
        },
      }),
    ).toThrow(/__/);
  });
  it("rejects a collection name that is not a bare SQL identifier", () => {
    // The name becomes a table name, and apply/ddl.ts interpolates some of those unquoted.
    expect(() =>
      ConfigSchema.parse({
        ...baseSchema,
        collections: {
          'pe"ople': {
            description: "d",
            fields: { id: { type: "uuid", posture: "allow" } },
          },
        },
      }),
    ).toThrow(/invalid/);
  });
  it("rejects a structured field with no type", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseSchema,
        collections: {
          people: {
            description: "d",
            fields: { name: { posture: "allow" } },
          },
        },
      }),
    ).toThrow();
  });
});

describe("taxonomies", () => {
  const base = {
    project: "t",
    server: { port: 1 },
    taxonomies: {
      category: {
        label: "Category",
        terms: { hr: { label: "HR" }, finance: { label: "Finance" } },
      },
    },
    collections: {},
  };

  it("parses and auto-adds the bound term field as text/allow (structured)", () => {
    const cfg = ConfigSchema.parse({
      ...base,
      collections: {
        notes: {
          description: "d",
          taxonomies: ["category"],
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
          },
        },
      },
    });
    expect(cfg.collections.notes!.fields.category).toEqual({
      posture: { read: "allow", write: "deny", unmask: "deny" },
      type: "text",
    });
    expect(cfg.taxonomies.category!.terms!.hr!.label).toBe("HR");
  });

  it("accepts the vocabulary slug as an extra file field and fills type text", () => {
    const cfg = ConfigSchema.parse({
      ...base,
      collections: {
        briefs: {
          description: "d",
          type: "file",
          source: "./x",
          taxonomies: ["category"],
          fields: {
            title: { posture: "allow" },
            content: { posture: "allow" },
            category: { posture: "deny" },
          },
        },
      },
    });
    expect(cfg.collections.briefs!.fields.category).toEqual({
      posture: { read: "deny", write: "deny", unmask: "deny" },
      type: "text",
    });
  });

  it("auto-adds the term field on a bound file collection when omitted", () => {
    const cfg = ConfigSchema.parse({
      ...base,
      collections: {
        briefs: {
          description: "d",
          type: "file",
          source: "./x",
          taxonomies: ["category"],
          fields: {
            title: { posture: "allow" },
            content: { posture: "allow" },
          },
        },
      },
    });
    expect(cfg.collections.briefs!.fields.category).toEqual({
      posture: { read: "allow", write: "deny", unmask: "deny" },
      type: "text",
    });
  });

  it("rejects binding an undeclared vocabulary", () => {
    expect(() =>
      ConfigSchema.parse({
        ...base,
        collections: {
          notes: {
            description: "d",
            taxonomies: ["nope"],
            fields: {
              id: { type: "uuid", posture: "allow", pk: true },
            },
          },
        },
      }),
    ).toThrow(/unknown vocabulary|binds unknown/);
  });

  it("rejects reserved and malformed vocabulary slugs", () => {
    expect(() =>
      ConfigSchema.parse({ ...base, taxonomies: { title: { label: "T", terms: {} } } }),
    ).toThrow(/invalid/);
    expect(() =>
      ConfigSchema.parse({ ...base, taxonomies: { "Bad-Slug": { label: "B", terms: {} } } }),
    ).toThrow(/invalid/);
  });

  it("rejects malformed term slugs", () => {
    expect(() =>
      ConfigSchema.parse({
        ...base,
        taxonomies: { category: { label: "C", terms: { Bad_Term: { label: "x" } } } },
      }),
    ).toThrow(/kebab-case/);
  });

  it("rejects a non-text bound field and pk/fk/view_join on it", () => {
    expect(() =>
      ConfigSchema.parse({
        ...base,
        collections: {
          notes: {
            description: "d",
            taxonomies: ["category"],
            fields: {
              id: { type: "uuid", posture: "allow", pk: true },
              category: { type: "int", posture: "allow" },
            },
          },
        },
      }),
    ).toThrow(/must be type text/);
    expect(() =>
      ConfigSchema.parse({
        ...base,
        collections: {
          notes: {
            description: "d",
            taxonomies: ["category"],
            fields: {
              id: { type: "uuid", posture: "allow", pk: true },
              category: {
                posture: "allow",
                view_join: { table: "departments", column: "name", on: "dept_id" },
              },
            },
          },
        },
      }),
    ).toThrow(/pk\/fk\/view_join/);
  });

  it("rejects untyped extra file fields and allows typed metadata fields", () => {
    // Untyped field without type is rejected
    expect(() =>
      ConfigSchema.parse({
        ...base,
        collections: {
          briefs: {
            description: "d",
            type: "file",
            source: "./x",
            taxonomies: ["category"],
            fields: {
              title: { posture: "allow" },
              sneaky: { posture: "allow" },
            },
          },
        },
      }),
    ).toThrow(/must have type text\/date/);
    // Typed metadata field is allowed
    const cfg = ConfigSchema.parse({
      ...base,
      collections: {
        briefs: {
          description: "d",
          type: "file",
          source: "./x",
          taxonomies: ["category"],
          fields: {
            title: { posture: "allow" },
            filed_date: { type: "date", posture: "allow" },
          },
        },
      },
    });
    expect(cfg.collections.briefs!.fields.filed_date!.type).toBe("date");
  });
});

it("accepts database.port, server.image and demo", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
  writeFileSync(
    join(dir, "warehousd.yml"),
    `
project: p
demo: true
database: { managed: true, port: 8723 }
server: { port: 8722, image: "ghcr.io/warehousd/warehousd:dev" }
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`,
  );
  const cfg = loadConfig(dir);
  expect(cfg.database?.port).toBe(8723);
  expect(cfg.server.image).toBe("ghcr.io/warehousd/warehousd:dev");
  expect(cfg.demo).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

it("defaults demo to false and leaves image/port undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
  writeFileSync(
    join(dir, "warehousd.yml"),
    `
project: p
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`,
  );
  const cfg = loadConfig(dir);
  expect(cfg.demo).toBe(false);
  expect(cfg.server.image).toBeUndefined();
  expect(cfg.database?.port).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

it("defaults audit to enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
  writeFileSync(
    join(dir, "warehousd.yml"),
    `
project: p
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`,
  );
  expect(loadConfig(dir).audit.enabled).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

it("accepts audit.enabled: false", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
  writeFileSync(
    join(dir, "warehousd.yml"),
    `
project: p
audit: { enabled: false }
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`,
  );
  expect(loadConfig(dir).audit.enabled).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// The point of the key is being able to turn it off per environment without editing the file that
// is checked in. Both routes have to yield a real boolean: interpolation is textual and runs
// before the YAML parse, so `${env:WH_AUDIT}` with "false" arrives as the bare token `false` — but
// nothing enforces that, and a schema that quietly coerced would read "false" as true.
it("turns audit off through warehousd.local.yml and through ${env:...}", () => {
  const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
  writeFileSync(
    join(dir, "warehousd.yml"),
    `
project: p
audit: { enabled: true }
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`,
  );
  writeFileSync(join(dir, "warehousd.local.yml"), `audit: { enabled: false }\n`);
  expect(loadConfig(dir).audit.enabled).toBe(false);

  writeFileSync(join(dir, "warehousd.local.yml"), `audit: { enabled: \${env:WH_TEST_AUDIT} }\n`);
  process.env.WH_TEST_AUDIT = "false";
  try {
    expect(loadConfig(dir).audit.enabled).toBe(false);
    process.env.WH_TEST_AUDIT = "true";
    expect(loadConfig(dir).audit.enabled).toBe(true);
  } finally {
    delete process.env.WH_TEST_AUDIT;
  }
  rmSync(dir, { recursive: true, force: true });
});

// Per-document ACLs. `acl: true` is a policy switch, so every way of arriving at one by accident
// is closed here rather than surfacing as a broken join at apply time.
describe("acl", () => {
  const parse = (collection: Record<string, unknown>) =>
    ConfigSchema.safeParse({ project: "p", collections: { c: collection } });

  const dataset = (over: Record<string, unknown> = {}) => ({
    description: "d",
    fields: { id: { type: "uuid", posture: "allow", pk: true } },
    ...over,
  });

  it("defaults to false", () => {
    const cfg = ConfigSchema.parse({ project: "p", collections: { c: dataset() } });
    expect(cfg.collections.c!.acl).toBe(false);
  });

  it("accepts acl: true on a dataset with a pk", () => {
    const cfg = ConfigSchema.parse({ project: "p", collections: { c: dataset({ acl: true }) } });
    expect(cfg.collections.c!.acl).toBe(true);
  });

  it("refuses acl: true with no primary key — an ACL is keyed on document identity", () => {
    const r = parse({
      description: "d",
      acl: true,
      fields: { name: { type: "text", posture: "allow" } },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("pk: true");
  });

  // A file collection declares no primary key — its documents are chunks of a file — so its ACL
  // is keyed on `path`, which is what identifies a file within a collection. See
  // CollectionKind.aclKeyField for why that and never `file_id`.
  it("accepts acl: true on a file collection, keyed on path", () => {
    const r = parse({
      description: "d",
      type: "file",
      source: "docs",
      acl: true,
      fields: { title: { posture: "allow" } },
    });
    expect(r.success).toBe(true);
  });

  it("refuses acl: true on a source_ref collection — warehousd does not own those rows", () => {
    const r = ConfigSchema.safeParse({
      project: "p",
      sources: { remote: { type: "postgres", url: "postgres://u:p@h:5432/d" } },
      collections: {
        c: {
          description: "d",
          acl: true,
          source_ref: { source: "remote", table: "t" },
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("source_ref");
  });

  // `.strict()` is what makes this a typo rather than a silent policy change: `acl_` parsing
  // cleanly would leave the author believing they had turned ACLs on.
  it("refuses a misspelt key rather than ignoring it", () => {
    expect(parse(dataset({ acl_: true })).success).toBe(false);
  });

  it("refuses a field called _acl — it is the view's ACL column", () => {
    const r = parse({
      description: "d",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        _acl: { type: "text", posture: "allow" },
      },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("reserved");
  });
});

describe("config schema rejects unrecognised keys", () => {
  // A typo in warehousd.yml used to parse cleanly and change policy. `postur: deny` left the field
  // with no declared posture at all, which is not the same thing as a field that denies — so the
  // config the operator wrote and the config the broker enforced were different documents.
  const minimal = {
    project: "t",
    collections: {
      people: { description: "P", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
    },
  };

  it("refuses a misspelled field key", () => {
    const cfg = structuredClone(minimal) as any;
    cfg.collections.people.fields.email = { type: "text", postur: "deny" };
    const r = ConfigSchema.safeParse(cfg);
    expect(r.success).toBe(false);
    // The message has to name the offending key, or a typo in a large file is unfindable.
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("postur");
  });

  it("refuses a misspelled collection key", () => {
    const cfg = structuredClone(minimal) as any;
    cfg.collections.people.writeable = true; // the real key is `writable`
    const r = ConfigSchema.safeParse(cfg);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("writeable");
  });

  it("refuses a misspelled top-level key", () => {
    const r = ConfigSchema.safeParse({ ...structuredClone(minimal), collectons: {} });
    expect(r.success).toBe(false);
  });

  it("refuses an unrecognised key inside view_join", () => {
    const cfg = structuredClone(minimal) as any;
    cfg.collections.people.fields.dept_id = {
      type: "uuid",
      posture: "allow",
      fk: "departments.id",
    };
    cfg.collections.people.fields.dept_name = {
      type: "text",
      posture: "allow",
      view_join: { table: "departments", column: "name", on: "dept_id", extra: 1 },
    };
    expect(ConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("still accepts every key the shipped example config uses", () => {
    // The guard against over-tightening: examples/harbor exercises taxonomies, view_join, file
    // collections, metadata fields, synthetic settings and the writable dataset.
    const dir = resolve(__dirname, "../../../examples/harbor");
    expect(() => loadConfig(dir)).not.toThrow();
  });
});

describe("server.runtime", () => {
  function load(runtimeLine: string): ReturnType<typeof loadConfig> {
    const dir = mkdtempSync(join(tmpdir(), "wh-cfg-"));
    writeFileSync(
      join(dir, "warehousd.yml"),
      `
project: p
server:
  port: 8722
${runtimeLine}
collections:
  a: { description: d, fields: { id: { type: uuid, posture: allow, pk: true } } }
`,
    );
    try {
      return loadConfig(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The default is a value, not "whichever engine is on PATH". A config that resolves differently
  // on two machines is a config that cannot be reviewed in git, which is the property the whole
  // product rests on.
  it("defaults to docker rather than to whatever is installed", () => {
    expect(load("").server.runtime).toBe("docker");
    expect(load("").server.runtime).toBe(DEFAULT_CONTAINER_RUNTIME_ID);
  });

  it("takes any id the registry implements", () => {
    for (const id of CONTAINER_RUNTIME_IDS) {
      expect(load(`  runtime: ${id}`).server.runtime).toBe(id);
    }
  });

  // A typo here would otherwise surface as `execFileSync("nerdctl")` failing with ENOENT deep in a
  // start, naming a binary the operator never asked for.
  it("refuses an engine with no module behind it", () => {
    expect(() => load("  runtime: nerdctl")).toThrow();
  });
});

describe("deploy config", () => {
  const baseWithDeploy = {
    project: "t",
    collections: {
      a: { description: "d", fields: { id: { type: "uuid", posture: "allow", pk: true } } },
    },
  };

  it("accepts a valid deploy block", () => {
    const cfg = ConfigSchema.parse({
      ...baseWithDeploy,
      deploy: {
        target: "fly",
        app_name: "my-app",
        region: "gru",
        database: { managed: true },
      },
    });
    expect(cfg.deploy?.target).toBe("fly");
    expect(cfg.deploy?.app_name).toBe("my-app");
  });

  it("accepts every registered target", () => {
    for (const target of DEPLOY_TARGET_IDS) {
      const cfg = ConfigSchema.parse({
        ...baseWithDeploy,
        deploy: {
          target,
          app_name: "my-app",
          // Judged by the target's own pre-flight, not here — which is what lets one schema hold
          // Fly's `gru` and Railway's `us-west2`.
          region: "us-west2",
          database: { managed: true },
        },
      });
      expect(cfg.deploy?.target).toBe(target);
    }
  });

  it("rejects a target nobody registered", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseWithDeploy,
        deploy: {
          target: "gcp",
          app_name: "my-app",
          region: "gru",
          database: { managed: true },
        },
      }),
    ).toThrow();
  });

  // The rule is a DNS label, which is what every target makes of this name — a Fly app, a Railway
  // project, a Compose service. The message used to say "a valid Fly app name", naming one target
  // in a schema that validates all of them.
  it("rejects app_name with uppercase or underscore", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseWithDeploy,
        deploy: {
          target: "fly",
          app_name: "My_App",
          region: "gru",
          database: { managed: true },
        },
      }),
    ).toThrow(/valid host name/);
  });

  // The shape of a region belongs to the target, not to this schema — Fly's slugs are three
  // letters, Railway's are `us-west2`, a Compose file has none. A `/^[a-z]{3}$/` here would have to
  // be edited for every target added, and would report a wrong region as a config parse error
  // rather than as the named pre-flight refusal the target can give it
  // (packages/cli/src/deploy/targets/fly.ts, the `fly-region` check).
  it("accepts a region this schema cannot judge, and leaves it to the target", () => {
    const cfg = ConfigSchema.parse({
      ...baseWithDeploy,
      deploy: {
        target: "fly",
        app_name: "my-app",
        region: "us-west2",
        database: { managed: true },
      },
    });
    expect(cfg.deploy?.region).toBe("us-west2");
  });

  it("rejects an empty region", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseWithDeploy,
        deploy: {
          target: "fly",
          app_name: "my-app",
          region: "",
          database: { managed: true },
        },
      }),
    ).toThrow(/region must not be empty/);
  });

  it("rejects database with neither managed nor url", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseWithDeploy,
        deploy: {
          target: "fly",
          app_name: "my-app",
          region: "gru",
          database: {},
        },
      }),
    ).toThrow(/exactly one of/);
  });

  it("rejects database with both managed and url", () => {
    expect(() =>
      ConfigSchema.parse({
        ...baseWithDeploy,
        deploy: {
          target: "fly",
          app_name: "my-app",
          region: "gru",
          database: { managed: true, url: "postgres://localhost" },
        },
      }),
    ).toThrow(/exactly one of/);
  });

  it("accepts database with managed: true alone", () => {
    const cfg = ConfigSchema.parse({
      ...baseWithDeploy,
      deploy: {
        target: "fly",
        app_name: "my-app",
        region: "gru",
        database: { managed: true },
      },
    });
    expect(cfg.deploy?.database.managed).toBe(true);
  });

  it("accepts database with url alone", () => {
    const cfg = ConfigSchema.parse({
      ...baseWithDeploy,
      deploy: {
        target: "fly",
        app_name: "my-app",
        region: "gru",
        database: { url: "postgres://db.example.com" },
      },
    });
    expect(cfg.deploy?.database.url).toBe("postgres://db.example.com");
  });

  it("rejects unknown key inside deploy", () => {
    const cfg = structuredClone(baseWithDeploy) as any;
    cfg.deploy = {
      target: "fly",
      app_name: "my-app",
      region: "gru",
      database: { managed: true },
      unknown_field: "value",
    };
    const r = ConfigSchema.safeParse(cfg);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("unknown_field");
  });

  it("accepts config with no deploy block (backwards compatible)", () => {
    const cfg = ConfigSchema.parse(baseWithDeploy);
    expect(cfg.deploy).toBeUndefined();
  });

  it("accepts database.provider alongside url", () => {
    const cfg = ConfigSchema.parse({
      ...baseWithDeploy,
      deploy: {
        target: "fly",
        app_name: "my-app",
        region: "gru",
        database: { url: "postgres://db.example.com", provider: "supabase" },
      },
    });
    expect(cfg.deploy?.database.provider).toBe("supabase");
  });

  it("leaves database.provider undefined when it is not declared", () => {
    const cfg = ConfigSchema.parse({
      ...baseWithDeploy,
      deploy: {
        target: "fly",
        app_name: "my-app",
        region: "gru",
        database: { url: "postgres://db.example.com" },
      },
    });
    expect(cfg.deploy?.database.provider).toBeUndefined();
  });

  // A provider with no url names where a database that is not there is hosted.
  // `provider` answers two different questions depending on the company it keeps. Alongside a
  // `url` it says who *hosts* the database you attached; alongside `managed: true` it says who
  // should *create* it. Both are meaningful, which is why the old "only applies alongside url"
  // rule had to go.
  function deployDatabase(database: Record<string, unknown>) {
    return ConfigSchema.safeParse({
      ...baseWithDeploy,
      deploy: { target: "fly", app_name: "my-app", region: "gru", database },
    });
  }

  it("accepts a provider that creates the database under `managed`", () => {
    for (const provider of PROVISIONABLE_DB_PROVIDER_IDS) {
      const r = deployDatabase({ managed: true, provider, region: "sa-east-1" });
      expect(r.success).toBe(true);
    }
  });

  it("still accepts `managed` alone, which leaves it to the deploy target", () => {
    expect(deployDatabase({ managed: true }).success).toBe(true);
  });

  // The one combination that means nothing: `generic` names no CLI to create anything with, and
  // Railway's database is provisioned by the Railway *target* rather than twice over.
  it("refuses a provider that cannot create a database", () => {
    for (const provider of ["generic", "railway"]) {
      const r = deployDatabase({ managed: true, provider });
      expect(r.success).toBe(false);
      if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("cannot provision");
    }
  });

  // A region with nothing to build is a key that decides nothing while reading as though it did —
  // the same objection the old rule made about `provider`.
  it("refuses a database region with no provider to build in it", () => {
    const r = deployDatabase({ url: "postgres://h/db", region: "sa-east-1" });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("only applies with");
  });

  it("rejects an unknown database.provider", () => {
    const r = ConfigSchema.safeParse({
      ...baseWithDeploy,
      deploy: {
        target: "fly",
        app_name: "my-app",
        region: "gru",
        database: { url: "postgres://db.example.com", provider: "cloudsql" },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe("envRefs", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wh-env-refs-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns unique env refs from warehousd.yml", () => {
    writeFileSync(
      join(dir, "warehousd.yml"),
      `
project: t
server:
  port: \${env:PORT}
database:
  url: \${env:DATABASE_URL}
  port: \${env:DB_PORT}
collections: {}
`,
    );
    const refs = envRefs(dir);
    expect(refs).toEqual(["DATABASE_URL", "DB_PORT", "PORT"]);
  });

  it("returns empty array when warehousd.yml has no refs", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "wh-env-refs-empty-"));
    writeFileSync(join(dir2, "warehousd.yml"), `project: t\ncollections: {}\n`);
    const refs = envRefs(dir2);
    expect(refs).toEqual([]);
    rmSync(dir2, { recursive: true, force: true });
  });

  it("returns empty array if warehousd.yml does not exist", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "wh-env-refs-missing-"));
    const refs = envRefs(dir2);
    expect(refs).toEqual([]);
    rmSync(dir2, { recursive: true, force: true });
  });

  it("does not return a ref that appears only in a whole-line comment", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "wh-env-refs-comment-"));
    writeFileSync(
      join(dir2, "warehousd.yml"),
      `
project: t
collections: {}
# This line contains \${env:COMMENTED_VAR}
`,
    );
    const refs = envRefs(dir2);
    expect(refs).not.toContain("COMMENTED_VAR");
    rmSync(dir2, { recursive: true, force: true });
  });

  it("does not return a ref that appears only in an inline comment", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "wh-env-refs-inline-"));
    writeFileSync(
      join(dir2, "warehousd.yml"),
      `
project: t
server:
  port: 8722  # alternative: \${env:COMMENTED_PORT}
collections: {}
`,
    );
    const refs = envRefs(dir2);
    expect(refs).not.toContain("COMMENTED_PORT");
    rmSync(dir2, { recursive: true, force: true });
  });

  it("returns a ref inside a quoted string even if it contains hash", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "wh-env-refs-quoted-"));
    writeFileSync(
      join(dir2, "warehousd.yml"),
      `
project: t
database:
  url: "postgres://user#pwd@host/db?ref=\${env:DB_ID}#section"
collections: {}
`,
    );
    const refs = envRefs(dir2);
    expect(refs).toContain("DB_ID");
    rmSync(dir2, { recursive: true, force: true });
  });

  it("merges refs from both warehousd.yml and warehousd.local.yml", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "wh-env-refs-merge-"));
    writeFileSync(
      join(dir2, "warehousd.yml"),
      `project: t\nserver:\n  port: \${env:PORT}\ncollections: {}\n`,
    );
    writeFileSync(join(dir2, "warehousd.local.yml"), `database:\n  url: \${env:LOCAL_DB}\n`);
    const refs = envRefs(dir2);
    expect(refs).toEqual(["LOCAL_DB", "PORT"]);
    rmSync(dir2, { recursive: true, force: true });
  });

  it("collapses duplicate refs across both files", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "wh-env-refs-dups-"));
    writeFileSync(
      join(dir2, "warehousd.yml"),
      `project: t\nserver:\n  port: \${env:PORT}\ndatabase:\n  url: \${env:PORT}\ncollections: {}\n`,
    );
    const refs = envRefs(dir2);
    expect(refs).toEqual(["PORT"]);
    expect(refs.filter((r) => r === "PORT")).toHaveLength(1);
    rmSync(dir2, { recursive: true, force: true });
  });
});
