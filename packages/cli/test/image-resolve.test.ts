import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveServerImage } from "../src/image-resolve";

// The precedence itself is not new — start.ts had it inline. What is new is being able to ask the
// question without performing the pull, which is what lets `doctor` and `start`'s preflight say
// which image is wanted *before* a registry error is the first mention of it.

let dir: string;

function writeConfig(extra = "") {
  writeFileSync(
    join(dir, "warehousd.yml"),
    `project: harbor\nserver:\n  port: 8722\n${extra}collections:\n  a:\n    description: d\n    fields:\n      id: { type: uuid, posture: allow, pk: true }\n`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wh-image-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveServerImage", () => {
  it("prefers server.image above everything", () => {
    writeConfig("");
    writeFileSync(
      join(dir, "warehousd.yml"),
      `project: harbor\nserver:\n  port: 8722\n  image: my/own:tag\ncollections:\n  a:\n    description: d\n    fields:\n      id: { type: uuid, posture: allow, pk: true }\n`,
    );
    const r = resolveServerImage(dir, { WAREHOUSD_IMAGE: "env/image:tag" });
    expect(r.ref).toBe("my/own:tag");
    expect(r.source).toBe("server.image");
  });

  it("falls back to WAREHOUSD_IMAGE", () => {
    writeConfig();
    const r = resolveServerImage(dir, { WAREHOUSD_IMAGE: "warehousd:dev" });
    expect(r.ref).toBe("warehousd:dev");
    expect(r.source).toBe("WAREHOUSD_IMAGE");
  });

  // This is the case that produced the reported incident: neither source set, so the CLI reached
  // for a registry tag while a locally built `warehousd:dev` sat unused and unmentioned.
  it("falls back to the GHCR default, and says that is where the name came from", () => {
    writeConfig();
    const r = resolveServerImage(dir, {});
    expect(r.ref).toContain("ghcr.io/tregismoreira/warehousd:");
    expect(r.source).toBe("default");
  });
});
