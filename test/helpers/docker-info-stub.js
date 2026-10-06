// Canned answers for the two `docker info --format` queries the wrappers use to
// detect a rootless daemon. A plain `docker info` (the availability check)
// always exits 0. Each query is { out, code }; an unlisted query exits 0 with
// no output, like the stubs did before rootless detection existed.
const ROOTLESS_DOCKER = {
  security: { out: '["name=seccomp,profile=builtin","name=rootless"]', code: 0 },
};
// Podman's own CLI has no SecurityOptions field, so that template fails.
const PODMAN_CLI = {
  security: { out: "", code: 1 },
  host: { out: "true", code: 0 },
};
const PODMAN_CLI_NOT_ROOTLESS = {
  security: { out: "", code: 1 },
  host: { out: "false", code: 0 },
};
// Same words in the wrong case: not the daemon's exact element.
const WRONG_CASE_ROOTLESS = {
  security: { out: '["NAME=ROOTLESS"]', code: 0 },
};
const UNREADABLE = {
  security: { out: "", code: 1 },
  host: { out: "", code: 1 },
};

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// POSIX sh: the body of the stub's `info` handling, replacing a bare
// `[ "$1" = info ] && exit 0`.
function infoStubSh(info = {}) {
  const answer = (q) => {
    if (!q) return "exit 0";
    const out = q.out ? `printf '%s\\n' ${shQuote(q.out)}; ` : "";
    const err = q.code !== 0 ? `echo 'template parsing error' >&2; ` : "";
    return `${out}${err}exit ${q.code}`;
  };
  return [
    'if [ "$1" = info ]; then',
    '  case "$*" in',
    `    *SecurityOptions*) ${answer(info.security)} ;;`,
    `    *Host.Security.Rootless*) ${answer(info.host)} ;;`,
    "  esac",
    "  exit 0",
    "fi",
  ].join("\n");
}

module.exports = {
  ROOTLESS_DOCKER,
  PODMAN_CLI,
  PODMAN_CLI_NOT_ROOTLESS,
  WRONG_CASE_ROOTLESS,
  UNREADABLE,
  infoStubSh,
};
