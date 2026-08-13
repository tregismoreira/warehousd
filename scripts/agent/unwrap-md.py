#!/usr/bin/env python3
"""Join hard-wrapped markdown paragraphs into one line each.

Leaves structure alone: fenced code, frontmatter, headings, tables, rules, HTML
blocks and link reference definitions. List items keep their marker and indent,
with continuation lines folded in.
"""
import re
import sys

FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
RULE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
TABLE = re.compile(r"^\s*\|")
HTML = re.compile(r"^\s*<")
LINKREF = re.compile(r"^\s{0,3}\[[^\]]+\]:\s")
BULLET = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+")
QUOTE = re.compile(r"^(\s*>\s?)")
ALERT = re.compile(r"^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$")


def is_structural(line: str) -> bool:
    return (
        not line.strip()
        or HEADING.match(line)
        or RULE.match(line)
        or TABLE.match(line)
        or HTML.match(line)
        or LINKREF.match(line)
    )


def unwrap(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    n = len(lines)

    # YAML frontmatter passes through untouched.
    if n and lines[0].strip() == "---":
        for j in range(1, n):
            if lines[j].strip() == "---":
                out.extend(lines[: j + 1])
                i = j + 1
                break

    while i < n:
        line = lines[i]

        if FENCE.match(line):
            marker = FENCE.match(line).group(1)
            out.append(line)
            i += 1
            while i < n:
                out.append(lines[i])
                if lines[i].strip().startswith(marker):
                    i += 1
                    break
                i += 1
            continue

        if is_structural(line):
            out.append(line)
            i += 1
            continue

        # A blockquote folds within itself, keeping one prefix.
        if QUOTE.match(line):
            prefix = QUOTE.match(line).group(1)
            content = line[len(prefix):].strip()
            # A GFM alert marker (`> [!WARNING]`) and a bare `>` separator must stay
            # alone on their own line — folding either into the next line breaks the
            # alert's rendering or erases the paragraph break within the quote.
            if not content or ALERT.match(content):
                out.append(line.rstrip())
                i += 1
                continue
            buf = [content]
            i += 1
            while (
                i < n
                and QUOTE.match(lines[i])
                and lines[i].strip() not in (">", "")
                and not ALERT.match(QUOTE.sub("", lines[i], count=1).strip())
            ):
                buf.append(QUOTE.sub("", lines[i], count=1).strip())
                i += 1
            out.append(prefix + " ".join(b for b in buf if b))
            continue

        # A list item folds its indented continuations in.
        m = BULLET.match(line)
        if m:
            buf = [line.rstrip()]
            indent = len(m.group(0))
            i += 1
            while i < n:
                nxt = lines[i]
                if is_structural(nxt) or FENCE.match(nxt) or BULLET.match(nxt):
                    break
                # Continuation must be indented at least to the item's text.
                if len(nxt) - len(nxt.lstrip()) < indent:
                    break
                buf.append(nxt.strip())
                i += 1
            out.append(" ".join(buf))
            continue

        # Plain paragraph.
        buf = [line.rstrip()]
        i += 1
        while i < n:
            nxt = lines[i]
            if is_structural(nxt) or FENCE.match(nxt) or BULLET.match(nxt) or QUOTE.match(nxt):
                break
            buf.append(nxt.strip())
            i += 1
        out.append(" ".join(b for b in buf if b))

    return "\n".join(out)


def words(text: str) -> list[str]:
    """Every word in the file, whitespace-normalised. Must not change.

    Blockquote markers are stripped outside code, because folding `> a` and
    `> b` into `> a b` renders identically but drops a `>` token.
    """
    kept, fenced = [], False
    for line in text.split("\n"):
        if FENCE.match(line):
            fenced = not fenced
            kept.append(line)
            continue
        kept.append(line if fenced else re.sub(r"^\s*>+\s?", "", line))
    return "\n".join(kept).split()


for path in sys.argv[1:]:
    with open(path) as fh:
        before = fh.read()
    after = unwrap(before)
    if words(before) != words(after):
        print(f"REFUSED (content would change): {path}", file=sys.stderr)
        sys.exit(1)
    if before != after:
        with open(path, "w") as fh:
            fh.write(after)
        print(f"unwrapped {path}")
