import { describe, it, expect } from "vitest";
import { helpScreen } from "../src/ui/help";
import { plainTheme } from "../src/ui/theme";

// Commander's default is every command in alphabetical order followed by every global flag, which
// answers "what exists" and not "what do I type first" — and alphabetical puts `apply`, a command
// nobody runs on their first day, above `init`. These pin the two rules that replaced it: common
// things first (clig.dev), and worked examples (12-factor CLI #1).

const screen = () => helpScreen(plainTheme);

describe("helpScreen", () => {
  it("says what the product is before it says what to type", () => {
    const lines = screen().split("\n");
    expect(lines[0]).toContain("all your documents and datasets");
    expect(screen()).toContain("Usage");
  });

  it("groups the commands in the order somebody meets them", () => {
    const s = screen();
    const at = (needle: string) => s.indexOf(needle);
    expect(at("Start here")).toBeGreaterThan(-1);
    expect(at("Start here")).toBeLessThan(at("Work with data"));
    expect(at("Work with data")).toBeLessThan(at("Change the schema"));
    expect(at("Change the schema")).toBeLessThan(at("Run it"));
    // The first command on the screen is the first one anybody runs.
    expect(at("init")).toBeLessThan(at("apply"));
  });

  it("lists every command the CLI has", () => {
    const s = screen();
    for (const name of [
      "init",
      "start",
      "open",
      "import",
      "seed",
      "index",
      "embed",
      "apply",
      "migrate",
      "status",
      "logs",
      "stop",
      "restart",
      "doctor",
      "secrets",
      "deploy",
    ]) {
      expect(s).toContain(name);
    }
  });

  it("shows real invocations, not a grammar", () => {
    const s = screen();
    expect(s).toContain("Examples");
    expect(s).toContain("warehousd import run products data.csv");
  });

  /**
   * The flags are deliberately absent.
   *
   * `--json`, `--quiet`, `--no-color` and `--verbose` are noise on a discovery screen — the
   * question this screen answers is which command to run — and every per-command `--help` still
   * lists them.
   */
  it("keeps the global flags off the discovery screen, and says where they are", () => {
    const s = screen();
    for (const flag of ["--json", "--quiet", "--no-color", "--verbose"]) {
      expect(s).not.toContain(flag);
    }
    expect(s).toContain("warehousd <command> --help shows every option.");
  });

  it("ends on the docs link", () => {
    expect(screen()).toContain("https://github.com/tregismoreira/warehousd");
  });

  // docs/glossary.md: the name is lowercase everywhere and never opens a sentence.
  it("keeps the name lowercase throughout", () => {
    expect(screen()).not.toContain("Warehousd");
  });

  it("carries no ANSI when there is no terminal behind it", () => {
    expect(screen()).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`));
  });
});
