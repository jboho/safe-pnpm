# Private Registries

safe-pnpm supports private/scoped registries without exposing your token to
untrusted install scripts. It does this with a [two-phase install](./security.md#two-phase-install):
the token is available only while dependencies are **downloaded** (with lifecycle
scripts disabled), then withheld while any build scripts run.

## Setup

Map the scope to your registry in the project's `.npmrc`, put the auth line in
your own `~/.npmrc` with the token as an environment variable, and export the
token:

```ini
# project .npmrc
@acme:registry=https://npm.acme.example/
```

```ini
# ~/.npmrc
//npm.acme.example/:_authToken=${NPM_TOKEN}
```

```sh
export NPM_TOKEN=your-read-only-token   # or NODE_AUTH_TOKEN
pnpm install
```

`NODE_AUTH_TOKEN` and `NPM_TOKEN` are forwarded into the fetch phase. The
container never sees your `~/.npmrc` itself: the wrapper copies only its auth
lines whose value is exactly `${NODE_AUTH_TOKEN}` or `${NPM_TOKEN}`, for a
token that is set, and removes that copy before the build phase. Lines holding
a literal token are never copied. If `NPM_CONFIG_USERCONFIG` points somewhere
else, that file is read instead of `~/.npmrc`.

The auth line can also sit in the project `.npmrc`, but pnpm 11 ignores it
there ("environment variables are not expanded in repository-controlled
registry credentials"), so the fetch reaches the registry with no token. npm
and yarn still read it. You no longer need `SAFE_PNPM_FORWARD_TOKENS=1` (it is
obsolete).

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
