import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@warehousd/broker";
import {
  runImportMap,
  runImportValidate,
  formatMapResult,
  formatValidateResult,
  defaultCollectionName,
  payloadFor,
} from "../src/import";
import { runInit, scaffoldFrom } from "../src/init";

// §P3d and §P6. `import map` is the inference engine and `init --from` is a second entry point to
// it, so both are exercised here — and the rule they share is asserted first: **nothing is
// written**.

let dir: string;

const SHEET = [
  "Full Name,Base Salary (USD),Work Email,Start Date,SSN,Bank Account,Employee ID",
  "Ana Souza,97300,ana@acme.com,2024-01-15,123-45-6789,GB33BUKB20201555555555,E-001",
  "Bruno Lima,88000,bruno@acme.com,2023-06-01,987-65-4321,GB94BARC10201530093459,E-002",
].join("\n");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-map-"));
  writeFileSync(
    join(dir, "warehousd.yml"),
    `project: t
collections:
  matters:
    description: Matters
    fields:
      id: { type: uuid, posture: allow, pk: true }
      matter_number: { type: text, posture: allow }
      opened_on: { type: date, posture: allow, nullable: true }
`,
  );
  writeFileSync(join(dir, "people.csv"), SHEET);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("import map proposes a collection", () => {
  it("never writes warehousd.yml", () => {
    const before = readFileSync(join(dir, "warehousd.yml"), "utf8");
    runImportMap(dir, join(dir, "people.csv"));
    expect(readFileSync(join(dir, "warehousd.yml"), "utf8")).toBe(before);
  });

  it("closes the sensitive columns and says why", () => {
    const r = runImportMap(dir, join(dir, "people.csv"));
    if (r.kind !== "collection") throw new Error("expected a collection proposal");
    const by = new Map(r.inferred.fields.map((f) => [f.field, f]));

    expect(by.get("base_salary")?.posture).toBe("deny");
    expect(by.get("ssn")?.posture).toBe("deny");
    expect(by.get("bank_account")?.posture).toBe("deny");
    // An email is masked to its domain rather than denied: the domain is what makes a directory
    // useful, the local part is what makes it personal data.
    expect(by.get("work_email")?.posture).toMatchObject({ read: "mask" });
    expect(by.get("work_email")?.mask).toEqual({ transform: "domain" });
    // Everything else stays open.
    expect(by.get("full_name")?.posture).toBe("allow");
    expect(by.get("start_date")?.posture).toBe("allow");
  });

  it("infers types and a single primary key", () => {
    const r = runImportMap(dir, join(dir, "people.csv"));
    if (r.kind !== "collection") throw new Error("expected a collection proposal");
    const by = new Map(r.inferred.fields.map((f) => [f.field, f]));
    expect(by.get("base_salary")?.type).toBe("int");
    expect(by.get("start_date")?.type).toBe("date");
    expect(by.get("full_name")?.type).toBe("text");
    expect(r.inferred.fields.filter((f) => f.pk)).toHaveLength(1);
  });

  it("proposes a mapping for every header that is not already a field name", () => {
    const r = runImportMap(dir, join(dir, "people.csv"));
    if (r.kind !== "collection") throw new Error("expected a collection proposal");
    expect(r.yaml).toContain('"Base Salary (USD)": base_salary');
    expect(r.yaml).toContain('"Full Name": full_name');
  });

  it("emits YAML that loads as a config", () => {
    const r = runImportMap(dir, join(dir, "people.csv"));
    // The proposal is meant to be pasted into warehousd.yml and applied. If it does not load, it
    // is a suggestion that wastes the reader's time working out what is wrong with it — so this
    // does exactly what a user does: paste it under a `project:` line and load the file.
    const yaml = r.yaml.replace(
      "description: TODO — say what this collection is, in one line",
      "description: People",
    );
    const proj = mkdtempSync(join(tmpdir(), "wh-paste-"));
    try {
      writeFileSync(join(proj, "warehousd.yml"), `project: t\n${yaml}\n`);
      const cfg = loadConfig(proj);
      expect(Object.keys(cfg.collections)).toEqual(["people"]);
      expect(cfg.collections.people!.import?.columns["Base Salary (USD)"]).toBe("base_salary");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("prints what it closed, and says it is a starting point", () => {
    const out = formatMapResult(runImportMap(dir, join(dir, "people.csv")));
    expect(out).toContain("STARTING POINT");
    expect(out).toContain("Closed by default");
    expect(out).toContain("base_salary");
  });
});

describe("import map against a collection that already exists", () => {
  it("proposes only the column mapping, and reports both directions", () => {
    writeFileSync(
      join(dir, "matters.csv"),
      "Matter Number,Opened On,Client\nM-1,2024-01-01,Acme\nM-2,2024-02-01,Beta",
    );
    const r = runImportMap(dir, join(dir, "matters.csv"));
    if (r.kind !== "mapping") throw new Error("expected a mapping proposal");
    expect(r.mapping.columns).toEqual({
      "Matter Number": "matter_number",
      "Opened On": "opened_on",
    });
    // A header with no field, and a required field with no header — different failures, both named.
    expect(r.mapping.unmatchedHeaders).toEqual(["Client"]);
    expect(r.mapping.missingRequired).toEqual(["id"]);
    const out = formatMapResult(r);
    expect(out).toContain("Headers with no field");
    expect(out).toContain("Required fields with no header");
  });
});

describe("import validate names the layer it ran", () => {
  it("says static, and points at --live for what it cannot see", async () => {
    writeFileSync(join(dir, "bad-matters.csv"), "id,matter_number\nnot-a-uuid,M-1");
    const r = await runImportValidate(dir, join(dir, "bad-matters.csv"), "matters");
    expect(r.ok).toBe(false);
    expect(r.layer).toBe("static");
    const out = formatValidateResult(r);
    expect(out).toContain("checked: static (no database)");
    expect(out).toContain("--live");
    expect(out).toContain("invalid_uuid".replace("invalid_uuid", "not a UUID"));
    // Invariant 4 again: the offending value is not in the report.
    expect(out).not.toContain("not-a-uuid");
  });

  it("passes a clean file and still names its blind spot", async () => {
    writeFileSync(
      join(dir, "good-matters.csv"),
      "id,matter_number\n3f8b0e4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b,M-1",
    );
    const r = await runImportValidate(dir, join(dir, "good-matters.csv"), "matters");
    expect(r.ok).toBe(true);
    expect(formatValidateResult(r)).toContain("not checked:");
  });
});

describe("payloadFor picks the format from the extension", () => {
  it("refuses a format it cannot read, by name", () => {
    writeFileSync(join(dir, "people.xls"), "not really");
    expect(() => payloadFor(join(dir, "people.xls"))).toThrow(/re-save it as \.xlsx/);
  });
});

describe("init --from reuses the same inference", () => {
  it("scaffolds one collection per spreadsheet", () => {
    const data = mkdtempSync(join(tmpdir(), "wh-data-"));
    writeFileSync(join(data, "people.csv"), SHEET);
    writeFileSync(join(data, "departments.csv"), "Name,Head Count\nLegal,12\nEngineering,40");
    writeFileSync(join(data, "notes.txt"), "not a spreadsheet");

    const s = scaffoldFrom(data);
    expect(s.collections.map((c) => c.name).sort()).toEqual(["departments", "people"]);
    rmSync(data, { recursive: true, force: true });
  });

  it("writes a scaffold whose postures are closed where the names look sensitive", async () => {
    const data = mkdtempSync(join(tmpdir(), "wh-data2-"));
    const proj = mkdtempSync(join(tmpdir(), "wh-proj-"));
    writeFileSync(join(data, "people.csv"), SHEET);

    const r = await runInit(proj, { from: data });
    expect(r.created).toContain("warehousd.yml");
    const yml = readFileSync(join(proj, "warehousd.yml"), "utf8");
    expect(yml).toContain("people:");
    expect(yml).toContain("base_salary: { type: int, posture: deny");
    expect(yml).toContain("transform: domain");
    // The scaffold has to say it is a guess, or somebody applies it as though it were a decision.
    expect(yml).toContain("GUESS");
    expect(r.inferred?.[0]?.name).toBe("people");

    rmSync(data, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("skips a file it cannot read rather than aborting the scaffold", () => {
    const data = mkdtempSync(join(tmpdir(), "wh-data3-"));
    writeFileSync(join(data, "good.csv"), "a,b\n1,2");
    writeFileSync(join(data, "broken.xlsx"), "definitely not a zip");
    const s = scaffoldFrom(data);
    expect(s.collections.map((c) => c.name)).toEqual(["good"]);
    expect(s.skipped[0]?.file).toBe("broken.xlsx");
    rmSync(data, { recursive: true, force: true });
  });
});

describe("defaultCollectionName", () => {
  it("takes the file stem", () => {
    expect(defaultCollectionName("/tmp/People Directory.xlsx")).toBe("people_directory");
  });
});
