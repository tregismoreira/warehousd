import type { CollectionConfig, FieldConfig, MaskConfig } from "../config/schema";

// Reading a spreadsheet and PROPOSING a collection — never writing one.
//
// The output of everything here is text for a human to read, correct and paste. `warehousd.yml` is
// the governed artefact: it is reviewed in a pull request and applied by `warehousd apply`, and an
// inference engine that edited it would make the file a cache of what a tool guessed rather than a
// record of what somebody decided. The whole point of §P4 is that the reviewer keeps the gate.
//
// One engine, two entry points: `warehousd import map` (a sheet against a collection) and
// `warehousd init --from ./data` (a directory of sheets into a first scaffold). Inference in one
// place, so the two cannot disagree about what a `salary` column is.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberately strict, unlike `Date.parse`. V8 will read "SPILL-DATE-1999" as 1999 and "Ana" as
// Invalid Date, and inferring `date` from the lenient parser turns a text column into a date
// column that then refuses most of its own rows.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const BOOLEAN_VALUES = new Set(["true", "false", "t", "f", "yes", "no", "0", "1"]);

/**
 * Headers whose contents warehousd assumes are sensitive until a human says otherwise.
 *
 * Deny-by-default is both the safe answer and the best possible first impression of what the
 * product is for: the alternative is a scaffold that exposes a salary column to every grant until
 * somebody notices. Matched as a substring on the normalised field name, so `Base Salary (USD)`,
 * `annual_salary` and `SALARY` all hit.
 *
 * It is a starting point, not a classifier. `import map` prints what it closed and why, and says
 * so plainly, because the list will both over- and under-reach on any real spreadsheet.
 */
export const SENSITIVE_HEADERS = [
  "ssn",
  "salary",
  "comp",
  "bank",
  "iban",
  "dob",
  "birth",
  "address",
  "phone",
  "passport",
] as const;

export type InferredPosture = {
  posture: FieldConfig["posture"];
  mask?: MaskConfig | undefined;
  /** Why this is not `allow`, for the report. Absent means it is. */
  closedBecause?: string | undefined;
};

/**
 * The posture a column gets before anybody has looked at it.
 *
 * **`deny` is checked before the email rule, and that ordering is deliberate.** `email_address`
 * contains `address`, so it comes back denied rather than masked to its domain — the stricter of
 * two plausible readings, chosen because every ambiguity here should resolve closed. The report
 * says which word closed it, so an author who meant the looser one can see why and change it.
 *
 * Substring matching over-reaches by design: `comp` catches `company_name` and `completed_at` as
 * well as `compensation`. A denied column that should not be is a line to edit in a proposal
 * nobody has applied yet; an exposed one is a disclosure.
 */
export function inferPosture(field: string): InferredPosture {
  const f = field.toLowerCase();
  const hit = SENSITIVE_HEADERS.find((s) => f.includes(s));
  if (hit) return { posture: "deny", closedBecause: `the name contains "${hit}"` };
  // An address is what an email is FOR, so it is masked rather than denied: the domain is what
  // makes a directory useful to a model, and the local part is what makes it personal data.
  if (f.includes("email") || f.includes("e_mail"))
    return {
      posture: { read: "mask", write: "deny", unmask: "deny" },
      mask: { transform: "domain" },
      closedBecause: "an email address is masked to its domain",
    };
  return { posture: "allow" };
}

/** A spreadsheet header as a field name: lowercase, underscores, no units in brackets. */
export function fieldNameFor(header: string): string {
  const base = header
    .trim()
    // "Base Salary (USD)" → "Base Salary". A unit is a fact about the column, not part of its name.
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .normalize("NFKD")
    // Strip combining marks, so "Salário" becomes "salario" rather than "sal_rio".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  // A field name must match [a-z_][a-z0-9_]* — a header that starts with a digit gets a prefix
  // rather than being silently truncated to something that collides with its neighbour.
  if (base === "") return "column";
  return /^[0-9]/.test(base) ? `col_${base}` : base;
}

export type InferredField = {
  header: string;
  field: string;
  type: NonNullable<FieldConfig["type"]>;
  nullable: boolean;
  pk: boolean;
  posture: FieldConfig["posture"];
  mask?: MaskConfig | undefined;
  closedBecause?: string | undefined;
  /** Whether the header and the field name differ, and so need an `import.columns` entry. */
  needsMapping: boolean;
};

export type InferredCollection = {
  name: string;
  fields: InferredField[];
  /** How many rows the inference looked at. Stated in the report — a guess from 20 rows is one. */
  sampled: number;
};

const blank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

// A parsed cell. `unknown` to the compiler because CSV, JSON and XLSX all hand back untyped
// values; anything non-scalar stringifies to "[object Object]", which infers as `text` and is
// exactly right — a column of objects is not a column warehousd can type.
function asText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
    return String(v).trim();
  return "[object]";
}

/** The narrowest type every non-blank value in the sample fits. */
function inferType(values: unknown[]): NonNullable<FieldConfig["type"]> {
  const present = values.filter((v) => !blank(v)).map(asText);
  if (present.length === 0) return "text";
  if (present.every((v) => UUID_RE.test(v))) return "uuid";
  if (present.every((v) => BOOLEAN_VALUES.has(v.toLowerCase()))) {
    // "0"/"1" alone are far more often a count or a flag column than booleans, and the wrong
    // guess here turns an integer into a boolean that then refuses the first `2`.
    if (present.every((v) => /^[01]$/.test(v))) return "int";
    return "boolean";
  }
  if (present.every((v) => TIMESTAMP_RE.test(v))) return "timestamptz";
  if (present.every((v) => DATE_RE.test(v))) return "date";
  if (present.every((v) => /^-?\d+$/.test(v))) return "int";
  if (present.every((v) => /^-?\d*\.?\d+([eE][-+]?\d+)?$/.test(v))) return "numeric";
  return "text";
}

/**
 * Propose a whole collection from a sheet.
 *
 * `pk` goes on the FIRST column whose sample is unique and complete, and on no other: two primary
 * keys is not a config the schema accepts, and a second candidate is usually a natural key
 * (an employee number, an email) that the author may prefer — which is a decision for them.
 */
export function inferCollection(
  name: string,
  rows: Record<string, unknown>[],
  opts: { sample?: number } = {},
): InferredCollection {
  const sample = rows.slice(0, opts.sample ?? 200);
  const headers = sample.length ? Object.keys(sample[0]!) : [];
  const used = new Set<string>();
  let pkTaken = false;

  const fields = headers.map((header): InferredField => {
    const values = sample.map((r) => r[header]);
    // A collision after normalisation — "Start Date" and "start_date" in one sheet — is resolved
    // with a suffix rather than by dropping one, and `import.columns` keeps both addressable.
    let field = fieldNameFor(header);
    let n = 2;
    while (used.has(field)) field = `${fieldNameFor(header)}_${n++}`;
    used.add(field);

    const nonBlank = values.filter((v) => !blank(v));
    const unique = new Set(nonBlank.map(asText)).size === nonBlank.length;
    const complete = nonBlank.length === sample.length && sample.length > 0;
    const pk = !pkTaken && unique && complete;
    if (pk) pkTaken = true;

    const p = inferPosture(field);
    return {
      header,
      field,
      type: inferType(values),
      nullable: !complete,
      pk,
      posture: p.posture,
      ...(p.mask ? { mask: p.mask } : {}),
      ...(p.closedBecause ? { closedBecause: p.closedBecause } : {}),
      needsMapping: header !== field,
    };
  });

  return { name, fields, sampled: sample.length };
}

export type InferredMapping = {
  collection: string;
  /** Header → field, for the `import.columns` block. Only where the two differ. */
  columns: Record<string, string>;
  /** Headers in the sheet that match no field. */
  unmatchedHeaders: string[];
  /** Non-nullable fields with no header, which an `append` will refuse. */
  missingRequired: string[];
};

/**
 * Match a sheet's headers against a collection that already exists.
 *
 * Reported in BOTH directions, because the two failures look nothing alike from the terminal: a
 * header with no field is a column that will not import, and a required field with no header is a
 * whole file that will not import.
 */
export function inferMapping(
  collection: string,
  c: CollectionConfig,
  headers: string[],
): InferredMapping {
  const fields = Object.entries(c.fields).filter(([, f]) => !f.view_join);
  const byName = new Map(fields.map(([n]) => [n, n]));
  const existing = c.import?.columns ?? {};

  const columns: Record<string, string> = {};
  const unmatchedHeaders: string[] = [];
  const matched = new Set<string>();

  for (const header of headers) {
    // Already mapped in the config, or already the field's own name: nothing to propose.
    const mapped = existing[header];
    if (mapped !== undefined) {
      matched.add(mapped);
      continue;
    }
    if (byName.has(header)) {
      matched.add(header);
      continue;
    }
    const guess = fieldNameFor(header);
    if (byName.has(guess) && !matched.has(guess)) {
      columns[header] = guess;
      matched.add(guess);
      continue;
    }
    unmatchedHeaders.push(header);
  }

  const missingRequired = fields.filter(([n, f]) => !f.nullable && !matched.has(n)).map(([n]) => n);

  return { collection, columns, unmatchedHeaders, missingRequired };
}

// --- rendering -------------------------------------------------------------------------------
//
// Hand-written rather than run through a YAML serialiser: what this prints is meant to be pasted
// into a file whose existing style it has to match, and a serialiser's quoting and key ordering
// are not that style. `.prettierignore` excludes YAML fixtures for the same reason.

const needsQuote = (s: string) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const yamlKey = (s: string) => (needsQuote(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function renderPosture(f: InferredField): string {
  if (typeof f.posture === "string") return `posture: ${f.posture}`;
  const p = f.posture;
  return `posture: { read: ${p.read}, write: ${p.write}, unmask: ${p.unmask} }`;
}

/** The `collections:` block to paste, for a collection that does not exist yet. */
export function renderCollectionYaml(inf: InferredCollection): string {
  const lines: string[] = [];
  lines.push("collections:");
  lines.push(`  ${yamlKey(inf.name)}:`);
  lines.push(`    description: TODO — say what this collection is, in one line`);

  const mapped = inf.fields.filter((f) => f.needsMapping);
  if (mapped.length) {
    lines.push(`    import:`);
    lines.push(`      columns:`);
    for (const f of mapped) lines.push(`        "${f.header}": ${f.field}`);
  }

  lines.push(`    fields:`);
  for (const f of inf.fields) {
    // A masked field needs a `mask:` key beside its posture, so it gets the block form. Everything
    // else fits on one line, which is what the shipped template and examples/harbor both do.
    if (f.mask) {
      lines.push(`      ${yamlKey(f.field)}:`);
      lines.push(`        type: ${f.type}`);
      lines.push(`        ${renderPosture(f)}`);
      lines.push(`        mask: { transform: ${f.mask.transform} }`);
      if (f.pk) lines.push(`        pk: true`);
      if (f.nullable) lines.push(`        nullable: true`);
      continue;
    }
    const bits = [`type: ${f.type}`, renderPosture(f)];
    if (f.pk) bits.push("pk: true");
    if (f.nullable) bits.push("nullable: true");
    lines.push(`      ${yamlKey(f.field)}: { ${bits.join(", ")} }`);
  }
  return lines.join("\n");
}

/** Just the `import.columns` block, for a collection that already exists. */
export function renderMappingYaml(m: InferredMapping): string {
  if (Object.keys(m.columns).length === 0) return "";
  const lines = ["collections:", `  ${yamlKey(m.collection)}:`, "    import:", "      columns:"];
  for (const [header, field] of Object.entries(m.columns))
    lines.push(`        "${header}": ${field}`);
  return lines.join("\n");
}
