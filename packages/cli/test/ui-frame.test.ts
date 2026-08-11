import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cmd,
  openFrame,
  displayWidth,
  frameClose,
  frameOpen,
  labelled,
  link,
  nextSteps,
  pad,
  rail,
  railDone,
  railFail,
  railLine,
  railWarn,
} from "../src/ui/frame";
import { plainTheme, resolveTheme } from "../src/ui/theme";

// The rail is the whole design: one frame per command, `┌` at the top, `│` down the side, `└` on
// a sentence saying what to do next. These pin the two renderings it has — the terminal one and
// the flat one a pipe gets — because the second is what the e2e suite reads.

const tty = resolveTheme({ isTTY: true, env: { NO_COLOR: "1" } });

describe("frameOpen and frameClose", () => {
  it("opens and closes on the frame glyphs, with content at column 4", () => {
    expect(frameOpen("warehousd start", tty)).toBe("┌  warehousd start");
    expect(frameClose("Run `warehousd open` next.", tty)).toBe("└  Run `warehousd open` next.");
  });

  /**
   * Off a terminal there is no frame at all — not an ASCII one.
   *
   * `packages/cli/test/e2e/lifecycle.e2e.test.ts` reads both streams through a pipe and asserts
   * what is in them. A rail drawn into that pipe is decoration nobody asked for, and it would put
   * a `|` in front of every line somebody greps.
   */
  it("draws nothing at all where there is no terminal", () => {
    expect(frameOpen("warehousd start", plainTheme)).toBeNull();
    expect(frameClose("anything", plainTheme)).toBeNull();
  });
});

describe("railLine", () => {
  it("hangs content from the rail on a terminal", () => {
    expect(railLine("Admin UI", tty)).toBe("│  Admin UI");
  });

  it("is the bare rail for a spacer", () => {
    expect(railLine("", tty)).toBe("│");
  });

  it("falls back to the flat two-space indent off one", () => {
    expect(railLine("Admin UI", plainTheme)).toBe("  Admin UI");
    expect(railLine("", plainTheme)).toBe("");
  });
});

describe("railWarn, railFail and railDone", () => {
  // The glyph takes the rail's own column rather than sitting beside it, so a warning is findable
  // in a page of output without colour having to do the work on its own.
  it("put the glyph in the rail column and hang the rest from the rail", () => {
    expect(railWarn(["first", "second"], tty).split("\n")).toEqual(["▲  first", "│  second"]);
    expect(railFail(["boom"], tty)).toBe("■  boom");
    expect(railDone(["fine"], tty)).toBe("◇  fine");
  });

  it("keep the flat indent and the ASCII glyph off a terminal", () => {
    expect(railWarn(["first", "second"], plainTheme).split("\n")).toEqual([
      "  ! first",
      "  second",
    ]);
  });
});

describe("rail", () => {
  it("keeps blocks separable by a bare rail line", () => {
    expect(rail(["a", "", "b"], tty).split("\n")).toEqual(["│  a", "│", "│  b"]);
  });
});

describe("displayWidth", () => {
  /**
   * The bug this exists for: an emoji is two terminal cells and two UTF-16 units, a variation
   * selector is none and one, and `String.length` is wrong about both — which knocks a whole
   * column of values out of line the moment one label carries an icon and its neighbour does not.
   */
  it("counts an emoji as the two cells it occupies", () => {
    expect(displayWidth("🚀")).toBe(2);
    expect(displayWidth("🚀 Deploy")).toBe(9);
  });

  it("counts a variation selector as nothing", () => {
    expect(displayWidth("🖥️")).toBe(2);
    expect("🖥️".length).toBeGreaterThan(2);
  });

  it("counts ordinary text by its characters", () => {
    expect(displayWidth("Admin UI")).toBe(8);
  });

  it("pads to display width, so an icon label lines up with a bare one", () => {
    expect(displayWidth(pad("🚀 Deploy", 14))).toBe(14);
    expect(displayWidth(pad("Project", 14))).toBe(14);
  });
});

describe("link", () => {
  // One colour, one meaning: cyan is somewhere you can go, applied by looking at the value rather
  // than by a flag at each call site.
  it("colours a URL and leaves an ordinary value alone", () => {
    const colour = resolveTheme({ isTTY: true, env: {} });
    expect(link("http://localhost:8722", colour)).not.toBe("http://localhost:8722");
    expect(link("postgres://u@h/db", colour)).not.toBe("postgres://u@h/db");
    expect(link("dev", colour)).toBe("dev");
  });
});

describe("nextSteps", () => {
  it("aligns what each command does past the longest of them", () => {
    const lines = nextSteps(
      "Next steps",
      [
        { command: "warehousd open", says: "open the admin UI" },
        { command: "warehousd seed", says: "fill it with synthetic data" },
      ],
      plainTheme,
    );
    expect(lines[0]).toBe("Next steps");
    expect(lines[1]!.indexOf("open the admin")).toBe(lines[2]!.indexOf("fill it"));
  });

  it("is empty when there is nothing to suggest", () => {
    expect(nextSteps("Next steps", [], plainTheme)).toEqual([]);
  });
});

describe("labelled and cmd", () => {
  it("drops the icon entirely rather than faking one in ASCII", () => {
    expect(labelled(plainTheme.i.database, "Database")).toBe("Database");
    expect(labelled(tty.i.database, "Database")).toContain("Database");
    expect(labelled(tty.i.database, "Database").length).toBeGreaterThan("Database".length);
  });

  it("marks a command as something you can type", () => {
    const colour = resolveTheme({ isTTY: true, env: { COLORTERM: "truecolor" } });
    expect(cmd("warehousd start", colour)).toContain("38;2;29;158;117");
    expect(cmd("warehousd start", plainTheme)).toBe("warehousd start");
  });
});

// The one impure export in the module, and the three flags that decide how much of it is drawn.
describe("openFrame", () => {
  function capture(fn: () => void, stream: "out" | "err" = "out") {
    const chunks: string[] = [];
    const target = stream === "out" ? process.stdout : process.stderr;
    const spy = vi.spyOn(target, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return chunks.join("");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws the corners, the spacers and one blank line after the close", () => {
    const out = capture(() => {
      const f = openFrame("warehousd stop", tty);
      f.block(railDone(["Containers stopped"], tty));
      f.close("Your data is untouched.");
    });
    expect(out).toBe(
      [
        "┌  warehousd stop",
        "│",
        "◇  Containers stopped",
        "│",
        "└  Your data is untouched.",
        "",
        "",
      ].join("\n"),
    );
  });

  // `--json` is parsed. Nothing decorative may reach that stream, corners included.
  it("writes nothing at all under --json", () => {
    const out = capture(() => {
      const f = openFrame("warehousd stop", tty, { json: true });
      f.block(railDone(["Containers stopped"], tty));
      f.close("anything");
    });
    expect(out).toBe("");
  });

  /**
   * `--quiet` keeps the result and drops the two corners.
   *
   * It means "only errors and results": the blocks are the result, and a greeting line plus a
   * suggestion about what to run next are neither.
   */
  it("keeps the blocks and drops the corners under --quiet", () => {
    const out = capture(() => {
      const f = openFrame("warehousd stop", tty, { quiet: true });
      f.block(railDone(["Containers stopped"], tty));
      f.close("Your data is untouched.");
    });
    expect(out).not.toContain("┌");
    expect(out).not.toContain("└");
    expect(out).toContain("◇  Containers stopped");
  });

  it("writes to stderr where the product on stdout must arrive unaccompanied", () => {
    const out = capture(
      () => openFrame("warehousd import map x.csv", tty, { stream: "err" }),
      "err",
    );
    expect(out).toBe("┌  warehousd import map x.csv\n");
  });

  it("skips an empty title, for a command that opens on something else", () => {
    const out = capture(() => openFrame("", tty));
    expect(out).toBe("");
  });
});
