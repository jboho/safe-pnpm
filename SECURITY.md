# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include the shell and OS, the package manager, and the smallest project or command that shows the problem. A way to run the sandbox escape or bypass locally is the most useful thing you can send.

This is a solo-maintained project. Expect an acknowledgement within a few days; there is no fixed fix-by date.

## Scope

safe-pnpm is a defense-in-depth layer for install time, not a complete supply-chain defense. [docs/security.md](./docs/security.md) lists what it protects and what it does not. In scope:

- A package's install or build script reaching the host, credentials, or other projects from inside the sandbox.
- Anything copied back to the host (`node_modules`, `package.json`, the lockfile, workspace manifests) that a build script can use to run code natively.
- A scan layer (audit, OSV, Socket) passing a result it should have blocked, or a wrapper failing open when it should fail closed.
- Registry tokens or `.npmrc` contents leaking into the build phase or onto disk after a run.

Out of scope: malicious code that runs at build or test time on the host, Docker or kernel vulnerabilities, and a compromised package registry attacking the package manager client.

## Supported versions

Only the latest release.
