import { describe, it, expect } from "vitest";
import { explain, formatExplained } from "../src/ui/errors";
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

  // Guessing wrong about an unfamiliar error is worse than passing it through: the reader can
  // search for Docker's words, but not for ours.
  it("passes an unrecognised error through untouched and adds no hint", () => {
    const e = explain(new Error("something nobody has seen before"));
    expect(e.title).toBe("something nobody has seen before");
    expect(e.hint).toBeUndefined();
  });

  it("handles a non-Error throw", () => {
    expect(explain("a bare string").title).toBe("a bare string");
  });
});

describe("formatExplained", () => {
  it("separates title and hint with a blank line", () => {
    expect(formatExplained({ title: "t", hint: "h" })).toBe("t\n\nh");
  });

  it("is just the title when there is no hint", () => {
    expect(formatExplained({ title: "t" })).toBe("t");
  });
});
