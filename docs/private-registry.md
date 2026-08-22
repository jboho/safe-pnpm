# Private Registries

safe-pnpm supports private/scoped registries without exposing your token to
untrusted install scripts. It does this with a [two-phase install](./security.md#two-phase-install):
the token is available only while dependencies are **downloaded** (with lifecycle
scripts disabled), then withheld while any build scripts run.

## Setup

Configure your registry exactly as you normally would — nothing safe-pnpm-specific
is required.

**Via `.npmrc`** (committed or in the project):

```ini
@acme:registry=https://npm.acme.example/
//npm.acme.example/:_authToken=${NPM_TOKEN}
```

**Via environment variable:**

```sh
export NPM_TOKEN=your-read-only-token   # or NODE_AUTH_TOKEN
pnpm install
```

`NODE_AUTH_TOKEN` and `NPM_TOKEN` are forwarded automatically into the fetch
phase, so `${NPM_TOKEN}`-style interpolation in `.npmrc` works. You no longer
need `SAFE_PNPM_FORWARD_TOKENS=1` (it is obsolete).

## What the token can and cannot reach

| Phase | Network | Token / `.npmrc` auth | Scripts |
|-------|---------|-----------------------|---------|
| Fetch | yes     | yes                   | disabled (`--ignore-scripts`) |
| Build | no*     | **stripped**          | run                           |

*Build runs with `--network none` by default. If a package's build step needs
network (rare — e.g. `esbuild`, `sharp`, `playwright` downloading a binary), set
`SAFE_PNPM_BUILD_NETWORK=1`. The token is still withheld in the build phase.

## Recommendations

- Use **read-only, registry-scoped** tokens. Even though the token never meets
  untrusted code here, least privilege is cheap insurance.
- Keep credentials in `${NPM_TOKEN}` env references rather than hardcoding them in
  a committed `.npmrc`.
- Non-auth `.npmrc` config (registry URLs, scopes, `node-linker`, hoisting) is
  preserved into the build phase; only credential lines are stripped.
