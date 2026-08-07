@AGENTS.md

The instructions for this repo are in AGENTS.md, so that every agent reads the same ones. This file only imports them.

Claude-specific: `.claude/settings.json` wires `scripts/agent/guard-heavy.sh` to PreToolUse/Bash and `scripts/agent/cleanup.sh` to SessionEnd, through the thin adapters in `.claude/hooks/`. The scripts hold the logic and run fine on their own; the adapters only speak the hook protocol.
