import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(fileURLToPath(import.meta.url), "../../unwrap-md.py");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "unwrap-md-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function unwrap(content: string): string {
  const file = path.join(dir, "doc.md");
  writeFileSync(file, content);
  execFileSync("python3", [SCRIPT, file]);
  return readFileSync(file, "utf8");
}

describe("unwrap-md.py", () => {
  // The bug this pins: a GFM alert marker immediately followed by its body (no blank `>` line
  // between them) used to get folded onto one line — `> [!WARNING] body text` — which GitHub does
  // not render as a styled callout. The marker must stay alone.
  it("keeps a GFM alert marker on its own line even when the body follows with no blank separator", () => {
    const before = ["> [!WARNING]", "> **Bold body text** that", "> wraps across two lines."].join(
      "\n",
    );
    const after = unwrap(before);
    expect(after).toBe(
      ["> [!WARNING]", "> **Bold body text** that wraps across two lines."].join("\n"),
    );
  });

  // The exact shape that broke in practice: marker, body, a bare `>` paragraph break, then a
  // second quoted paragraph. The separator has to survive as its own line, not get consumed as
  // the opening line of a fold that swallows the next paragraph too.
  it("preserves a bare `>` separator between an alert body and a second paragraph", () => {
    const before = [
      "> [!WARNING]",
      "> **Bold body text** that",
      "> wraps across two lines.",
      ">",
      "> [a link](x) in a second",
      "> paragraph.",
    ].join("\n");
    const after = unwrap(before);
    expect(after).toBe(
      [
        "> [!WARNING]",
        "> **Bold body text** that wraps across two lines.",
        ">",
        "> [a link](x) in a second paragraph.",
      ].join("\n"),
    );
  });

  it("still folds a plain wrapped paragraph outside any blockquote", () => {
    const before = ["Some", "wrapped", "paragraph."].join("\n");
    expect(unwrap(before)).toBe("Some wrapped paragraph.");
  });

  it("leaves an already-correct alert block untouched", () => {
    const before = [
      "# Test",
      "",
      "> [!WARNING]",
      "> One line body.",
      "",
      "Trailing paragraph.",
      "",
    ].join("\n");
    expect(unwrap(before)).toBe(before);
  });
});
