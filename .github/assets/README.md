# Diagram style

Every diagram in this repo is a hand-authored SVG in one visual language. Not Mermaid: the diagrams here carry annotation columns, spec tables and deliberate placement, none of which survive a layout engine you cannot steer — and running Mermaid *and* SVG would be two styles, which is the thing this file exists to prevent.

Consequences worth knowing before you add one:

- **Diagrams drift.** An SVG is not checked against the code by anything. When you change a boundary, a schema or an adapter, grep this directory.
- **`alt` carries the content.** The image is the only copy of what the diagram says, so the `alt` text is a full prose description, not a caption. Write it as if the reader will never see the picture, because some will not.
- **Dark only, on purpose.** The canvas is opaque, so it reads as a code block in GitHub's light mode rather than inverting. If a light variant is ever wanted, use `<picture>` with `prefers-color-scheme` rather than restyling.

## Tokens

The palette is the banner's. `banner.svg` is an export and the only asset none of this is authored by hand, so it is the source of truth: its canvas (`#0F1115`), its mark (`#F4F6F8`) and its accent (`#1D9E75`) are fixed points, and the intermediate greys are a ramp derived from them — hue 214, low saturation, so nothing reads warm next to the wordmark.

| Role | Value |
| --- | --- |
| Canvas | `#0F1115`, `rx="10"` — the banner's background |
| Panel | fill `#1A1E23`, stroke `#31373F`, `rx="6"` |
| Accent — broker, allow, audit | `#1D9E75` — the banner's bar |
| Refusal | `#D97757`, `stroke-dasharray="4 3"` |
| Emphasis band | fill `#14241F`, stroke `#1D9E75` |
| Text — primary | `#F4F6F8` — the banner's mark |
| Text — muted, labels, second column | `#7E8A9A` |
| Arrow | `#5B6471`, `stroke-width="1.5"`, marker `#a` |

Every text pair clears WCAG AA on its own background: primary 15.5:1, muted 4.8:1, accent 4.9:1, refusal 5.4:1. A new colour has to hold that, which in practice means deriving it rather than picking it.

Font is the `ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace` stack, set once on a wrapping `<g>`.

## Metrics

Because everything is monospaced, layout is arithmetic — a glyph is `0.6em` wide, so 13px text is 7.8px per character and 11px text is 6.6px. Check that a string fits its panel before committing; nothing renders this in CI.

| Property | Value |
| --- | --- |
| Width | 960, with a 30px margin on all sides |
| Section label | 10px, `letter-spacing="1.6"`, uppercase, muted, baseline 12px above its panel |
| Body text | 13px, 23px line rhythm, inset 16px from the panel's `x` |
| Secondary note | 11px |
| First body baseline | panel `y` + 28 |
| Divider | a `#34373C` line inset 16px from both panel edges |

## Files

| File | What it shows |
| --- | --- |
| `banner.svg` | The wordmark lockup for the README header. Exported, not hand-authored. |
| `concepts.svg` | The request path: person → MCP client → broker → allow or refuse, plus what a grant is. |
| `architecture.svg` | The two host processes, the broker boundary, what is injected into it, and the schemas. |
| `logo.png` | Raster fallback. |
