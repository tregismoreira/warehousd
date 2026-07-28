# warehousd

Governed MCP data platform — CLI

## Install

```bash
npm install -g warehousd
```

Or use directly with npx:

```bash
npx warehousd
```

## Commands

- `init` - Initialize a new warehousd project
- `start` - Start the warehousd data platform
- `stop` - Stop the running platform
- `status` - Check platform status
- `apply` - Apply configuration changes
- `seed` - Seed the database with initial data
- `index` - Index data for search
- `regen-synth` - Regenerate synthetic data

After `start`, the platform outputs a contract file to `.warehousd/outputs.json` with deployment and connection details.
