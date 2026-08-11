import { describe, it, expect } from "vitest";
import { explain, formatExplained, errorOutro, ISSUES_URL } from "../src/ui/errors";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// What a terminal gets, with colour off so the strings stay readable in an assertion.
const railTheme = resolveTheme({ isTTY: true, env: { NO_COLOR: "1" } });
import { DockerError } from "../src/docker";

describe("explain", () => {
  it("turns a port clash into an instruction about warehousd.yml", () => {
    const e = explain(
      new DockerError(
        "docker: Error response from daemon: driver failed programming external connectivity on endpoint wh_harbor_server: Bind for 127.0.0.1:8722 failed: port is already allocated",
      ),
    );
    expect(e.title).toContain("already in use");
    expect(e.hint).toContain("server.port");
  });

  // The incident this module was written for: the tag was never named, and a locally built image
  // sat unused because nothing said which one `start` wanted.
  it("names the fix when the image cannot be pulled", () => {
    const e = explain(
      new DockerError(
        "Error response from daemon: manifest unknown: manifest unknown for ghcr.io/tregismoreira/warehousd:0.1.0",
      ),
    );
    expect(e.title).toContain("Could not pull the server image");
    // The original text survives, so the tag is still visible.
    expect(e.title).toContain("ghcr.io/tregismoreira/warehousd:0.1.0");
    expect(e.hint).toContain("WAREHOUSD_IMAGE");
    expect(e.hint).toContain("docker build");
  });

  it("recognises pull access denied", () => {
    const e = explain(
      new DockerError("pull access denied for warehousd, repository does not exist"),
    );
    expect(e.hint).toContain("server.image");
  });

  it("recognises a stopped daemon", () => {
    const e = explain(
      new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
    );
    expect(e.title).toContain("daemon isn't reachable");
    expect(e.hint).toContain("Docker Desktop");
  });

  it("recognises a full disk", () => {
    const e = explain(new DockerError("write /var/lib/docker: no space left on device"));
    expect(e.hint).toContain("docker system prune");
  });

  it("points a failed health check at the logs command", () => {
    const e = explain(new Error("Container health check failed: Error: Health check timeout"));
    expect(e.hint).toContain("warehousd logs");
  });

  it("recognises an unreachable database", () => {
    const e = explain(new Error("connect ECONNREFUSED 127.0.0.1:8723"));
    expect(e.hint).toContain("warehousd status");
  });

  /**
   * Guessing wrong about an unfamiliar error is worse than passing it through: the reader can
   * search for Docker's words, but not for ours.
   *
   * What it does add is the *reference* the 12-factor CLI's fifth rule asks for. We cannot say how
   * to fix something we did not recognise; we can say who to tell.
   */
  it("passes an unrecognised error through untouched and adds no hint", () => {
    const e = explain(new Error("No secrets yet — run `warehousd start` first."));
    expect(e.title).toBe("No secrets yet — run `warehousd start` first.");
    expect(e.hint).toBeUndefined();
    expect(e.unexpected).toBeUndefined();
  });

  /**
   * "No rule matched" is not the same as "unexpected".
   *
   * Most unmatched errors are warehousd's own finished sentences, and telling the reader to open
   * an issue about one of those is both wrong and rude. A TypeError is a bug in our code and
   * nobody should ever see one, so that is what gets the tracker link.
   */
  it("marks a programmer error as unexpected, and names it", () => {
    const e = explain(new TypeError("cannot read properties of undefined"));
    expect(e.title).toContain("Unexpected error");
    expect(e.title).toContain("TypeError");
    expect(e.hint).toContain("--verbose");
    expect(e.unexpected).toBe(true);
  });

  it("handles a non-Error throw", () => {
    expect(explain("a bare string").title).toBe("a bare string");
  });

  it("does not mark a recognised error as unexpected", () => {
    expect(explain(new Error("connect ECONNREFUSED 127.0.0.1:8723")).unexpected).toBeUndefined();
  });
});

describe("formatExplained", () => {
  // The `■` takes the rail's own column and the hint hangs from the rail under it, so a failure is
  // part of the same frame as the steps that led to it rather than a separate thing afterwards.
  it("puts the failure glyph in the rail column and the hint on the rail", () => {
    expect(formatExplained({ title: "t", hint: "h" }, railTheme)).toBe(
      `${railTheme.s.fail}  t\n${railTheme.s.bar}  h`,
    );
  });

  it("is just the title when there is no hint", () => {
    expect(formatExplained({ title: "t" }, railTheme)).toBe(`${railTheme.s.fail}  t`);
  });

  // The rules that keep the driver's own words append them to the title on a second line. Those
  // have to stay legible rather than left at column 0 under an indented first line.
  it("hangs a multi-line title from the rail under its own first line", () => {
    expect(formatExplained({ title: "first\nsecond" }, railTheme)).toBe(
      `${railTheme.s.fail}  first\n${railTheme.s.bar}  second`,
    );
  });

  it("falls back to the flat indent off a terminal", () => {
    expect(formatExplained({ title: "t", hint: "h" })).toBe(`  ${plainTheme.s.fail} t\n  h`);
  });

  // Blank lines belong to the caller, as with the wordmark and the release-candidate notice.
  it("brings no blank line of its own", () => {
    const s = formatExplained({ title: "t", hint: "h" });
    expect(s.startsWith("\n")).toBe(false);
    expect(s.endsWith("\n")).toBe(false);
  });

  it("carries no ANSI when there is no terminal behind it", () => {
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
    expect(formatExplained({ title: "t", hint: "h" })).not.toMatch(ansi);
  });
});

/**
 * A failure never ends on a bare stack of red.
 *
 * clig.dev's rule and Atlassian's seventh: suggest the next best step, always. The `└` is the line
 * that says which way out is, and for an error no rule recognised the way out is the tracker.
 */
describe("errorOutro", () => {
  it("names the command to re-run", () => {
    expect(errorOutro({ title: "t" }, "start", railTheme)).toBe(
      "└  Fix the problem above, then re-run `warehousd start`.",
    );
  });

  it("says something useful even where no command reached the handler", () => {
    expect(errorOutro({ title: "t" }, null, railTheme)).toContain("try again");
  });

  it("points an unexpected error at the issue tracker", () => {
    const s = errorOutro({ title: "t", unexpected: true }, "start", railTheme) ?? "";
    expect(s).toContain(ISSUES_URL);
    expect(s).not.toContain("re-run");
  });

  it("draws nothing where there is no frame to close", () => {
    expect(errorOutro({ title: "t" }, "start", plainTheme)).toBeNull();
  });
});
