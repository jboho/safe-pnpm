# CLAUDE.md — safe-pnpm

Node CLI and shell wrappers; npm (package-lock.json), no build step.

## Common commands

```bash
node --test test/<file>.test.js    # one test file
npm test                           # full suite (node --test test/*.test.js)
npm run lint                       # oxlint + biome lint, read-only
npm run check                      # biome check --write: rewrites files, review the diff after
```
