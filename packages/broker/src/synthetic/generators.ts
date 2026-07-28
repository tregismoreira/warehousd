import firstNames from "../../wordlists/first-names.json" with { type: "json" };
import lastNames from "../../wordlists/last-names.json" with { type: "json" };
import streets from "../../wordlists/streets.json" with { type: "json" };
import jobTitles from "../../wordlists/job-titles.json" with { type: "json" };
import companies from "../../wordlists/companies.json" with { type: "json" };
import industries from "../../wordlists/industries.json" with { type: "json" };
import courts from "../../wordlists/courts.json" with { type: "json" };
import legalNarratives from "../../wordlists/legal-narratives.json" with { type: "json" };

// Mulberry32 — deterministic PRNG.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;

const documentCategories = [
  "Contract", "Policy", "Report", "Proposal", "Memo",
  "Invoice", "Presentation", "Meeting Notes", "Onboarding Guide", "Audit",
];

const departmentNames = [
  "Finance", "Engineering", "Sales", "Marketing", "Human Resources",
  "Legal", "Operations", "Customer Support", "Product", "IT",
];

export const wordlists = { firstNames, lastNames, streets, jobTitles, companies, industries, courts, legalNarratives };

export function genValue(
  rng: () => number, type: string, field: string,
  opts: { min?: number; max?: number; gen?: string; i?: number; project?: string } = {},
): unknown {
  const f = field.toLowerCase();

  // Dispatch on opts.gen first — explicit hints win over substring guessing
  if (opts.gen) {
    switch (opts.gen) {
      case "client_number": {
        const idx = (opts.i ?? 0) + 1;
        return `C-${String(idx).padStart(4, "0")}`;
      }
      case "matter_number": {
        const idx = (opts.i ?? 0) + 1;
        return `M-2025-${String(idx).padStart(4, "0")}`;
      }
      case "invoice_number": {
        const idx = (opts.i ?? 0) + 1;
        return `INV-2025-${String(idx).padStart(4, "0")}`;
      }
      case "bar_number": {
        const idx = (opts.i ?? 0) + 1;
        return `BAR-${String(idx).padStart(6, "0")}`;
      }
      case "company_name": return pick(rng, wordlists.companies);
      case "hourly_rate": {
        const lo = opts.min ?? 150, hi = opts.max ?? 950;
        const n = lo + rng() * (hi - lo);
        return Math.round(n);
      }
      case "narrative": return pick(rng, wordlists.legalNarratives);
      case "court_name": return pick(rng, wordlists.courts);
      case "industry": return pick(rng, wordlists.industries);
    }
  }

  switch (type) {
    case "uuid": return uuidFrom(rng);
    case "numeric":
    case "int": {
      const lo = opts.min ?? 0, hi = opts.max ?? 1000;
      const n = lo + rng() * (hi - lo);
      return type === "int" ? Math.round(n) : Math.round(n * 100) / 100;
    }
    case "boolean": return rng() < 0.5;
    case "date":
    case "timestamptz": {
      // spread over ~5 years back from a fixed epoch (deterministic — no Date.now)
      const base = Date.parse("2025-01-01T00:00:00Z");
      const d = new Date(base - Math.floor(rng() * 5 * 365) * 86400000);
      return type === "date" ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    case "json": return { note: pick(rng, wordlists.firstNames) };
    default: { // text — shape by field name
      if (f.includes("email"))
        return `${pick(rng, firstNames)}.${pick(rng, lastNames)}@${opts.project ?? "example"}.example`.toLowerCase();
      if (f.includes("full_name")) return `${pick(rng, firstNames)} ${pick(rng, lastNames)}`;
      if (f === "name") return pick(rng, departmentNames);
      if (f.includes("name")) return `${pick(rng, firstNames)} ${pick(rng, lastNames)}`;
      if (f.includes("address")) return `${1 + Math.floor(rng() * 999)} ${pick(rng, streets)}`;
      if (f.includes("title")) return pick(rng, jobTitles);
      if (f.includes("currency")) return "USD";
      if (f.includes("category")) return pick(rng, documentCategories);
      if (f.includes("owner")) return `${pick(rng, firstNames)} ${pick(rng, lastNames)}`;
      return `${pick(rng, wordlists.firstNames)}-${Math.floor(rng() * 1000)}`;
    }
  }
}

function uuidFrom(rng: () => number): string {
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) s += h[Math.floor(rng() * 16)];
  return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`;
}
