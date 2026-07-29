import { existsSync, writeFileSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const WAREHOUSD_TEMPLATE = `project: my-app
server:
  port: 8722
# database:
#   managed: true                 # default — the CLI runs Postgres in Docker
#   url: ` + '${env:DATABASE_URL}' + `      # alternative: bring your own Postgres

collections:
  announcements:
    description: Company announcements
    fields:
      id:         { type: uuid,        posture: allow, pk: true }
      title:      { type: text,        posture: allow }
      summary:    { type: text,        posture: allow }
      owner:      { type: text,        posture: allow }
      updated_at: { type: timestamptz, posture: allow }

# ── More examples ─────────────────────────────────────────────────────────────
# posture: deny is the hard tier — such a field can NEVER be granted; changing it
# requires editing this file. posture: allow still means deny-by-default per user
# until a manager approves a grant covering the field.
#
#  people:
#    description: Employee directory
#    fields:
#      id:              { type: uuid, posture: allow, pk: true }
#      full_name:       { type: text, posture: allow }
#      department_name: { type: text, posture: allow, view_join: { table: departments, column: name, on: department_id } }
#      department_id:   { type: uuid, posture: allow, fk: departments.id }
#      home_address:    { type: text, posture: deny }
#
#  policies:                        # a file collection: markdown indexed for search
#    type: file
#    description: Policy documents
#    taxonomies: [category]         # bind the category vocabulary to this collection
#    source: ./docs                 # DEV content; live indexing needs \`source_live\`
#    fields:
#      title:   { posture: allow }
#      content: { posture: allow }
#      owner:   { posture: allow }
#
# taxonomies:
#   category:
#     label: Category
#     multiple: true
#     terms:
#       hr:       { label: HR }
#       benefits: { label: Benefits }
#
# synthetic:
#   documents_per_collection: { announcements: 25 }
`;

export async function runInit(
  dir: string,
  opts?: { force?: boolean },
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Create warehousd.yml
  const ymlPath = join(dir, "warehousd.yml");
  if (!existsSync(ymlPath) || opts?.force) {
    writeFileSync(ymlPath, WAREHOUSD_TEMPLATE);
    created.push("warehousd.yml");
  } else {
    skipped.push("warehousd.yml");
  }

  // Ensure .gitignore exists and append entries
  const gitignorePath = join(dir, ".gitignore");
  let gitignoreContent = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";

  // Append warehousd.local.yml if not present
  if (!gitignoreContent.includes("warehousd.local.yml")) {
    if (gitignoreContent && !gitignoreContent.endsWith("\n")) {
      gitignoreContent += "\n";
    }
    gitignoreContent += "warehousd.local.yml\n";
  }

  // Append .warehousd/ if not present
  if (!gitignoreContent.includes(".warehousd/")) {
    if (gitignoreContent && !gitignoreContent.endsWith("\n")) {
      gitignoreContent += "\n";
    }
    gitignoreContent += ".warehousd/\n";
  }

  writeFileSync(gitignorePath, gitignoreContent);

  return { created, skipped };
}
