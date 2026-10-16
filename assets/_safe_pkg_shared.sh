# _safe_pkg_shared.sh — shared logic for safe-pnpm, safe-npm, safe-yarn wrappers
# Sourced automatically by each manager wrapper — do not source directly.

_SAFE_PKG_SHARED_LOADED=1

# _safe_pkg_valueflags manager
#   Prints the global flags that take a separate value, space-separated, so
#   the finders below can skip the value instead of reading it as a command.
#   npx takes npm's list.
_safe_pkg_valueflags() {
  case "$1" in
    pnpm) printf '%s' "-C --dir -F --filter --filter-prod --workspace-dir --reporter --loglevel --config --store-dir --state-dir --registry --lockfile-dir --network-concurrency --fetch-timeout --workspace-concurrency --test-pattern --changed-files-ignore-pattern --http-proxy --https-proxy --no-proxy --user-agent" ;;
    npm|npx) printf '%s' "--prefix -w --workspace --registry --cache --userconfig --globalconfig --loglevel --otp --scope --omit --include --install-strategy --tag --before --audit-level --fetch-retries --lockfile-version --min-release-age --cpu --os --libc --script-shell --node-options --maxsockets --location" ;;
    yarn) printf '%s' "--cwd --registry --modules-folder --cache-folder --preferred-cache-folder --global-folder --link-folder --network-concurrency --network-timeout --proxy --https-proxy --mutex --use-yarnrc --cafile --otp" ;;
  esac
}

# _safe_pkg_subcmd manager [args...]
#   Prints the install-class subcommand (lowercased, hyphens removed) and
#   returns 0, or prints nothing. Walks the non-flag words in order:
#     - an install word or alias           -> that is the subcommand
#     - a known non-install command        -> nothing (run native)
#     - anything else                      -> maybe the value of a flag missing
#                                             from the list below; try the next word
#   so an unknown value-taking flag fails closed. Flags in the list, and the
#   directory flags of _safe_pkg_dir_flag, have their value skipped, so
#   `pnpm --filter test add x` is still an add. A skipped word is never an
#   install word or a flag: the parsers differ on whether a flag takes the
#   next word as its value when it looks like a flag (npm's path and URL flags
#   do, pnpm's string flags do not), so either reading lands on the scan or a
#   refusal. npm also accepts unambiguous prefixes (`npm uninst x`), so two or
#   more letters that start an install name count. Words after -- are walked
#   too: npm and pnpm still run `npm -- install x` as an install, and yarn
#   takes the command from before --, so `yarn global -- add x` is a global
#   add. Bare `yarn` is an install (yarn v1).
_safe_pkg_subcmd() {
  local manager="$1" install native valueflags a n inst skip=0 seen=0 g=0
  shift
  case "$manager" in
    pnpm)
      install=" install i add update up upgrade ci clean-install ic install-clean fetch remove rm un uninstall uni install-test it unlink dislink "
      native=" run exec dlx test t start stop restart publish pack list ls ll la why outdated audit config c get set init create link ln rebuild rb approve-builds store root bin patch patch-commit patch-remove import prune dedupe deploy licenses help env self-update setup doctor server cat-file cat-index find-hash " ;;
    npm)
      install=" install i in ins inst insta instal isnt isnta isntal isntall add ci clean-install ic install-clean isntall-clean install-test it cit install-ci-test sit clean-install-test update up upgrade udpate u uninstall un unlink remove rm r "
      native=" run run-script rum urn test t tst start stop restart exec x publish pack version v view info show config c get set ls list la ll audit outdated login logout whoami init create innit pkg prefix root bin docs help ping search team token owner access dist-tag deprecate cache link ln rebuild rb dedupe find-dupes explain why fund diff doctor " ;;
    yarn)
      install=" install add remove upgrade upgrade-interactive "
      native=" run test start publish pack create init list ls info why outdated audit cache check config link unlink login logout owner tag team version versions bin generate-lock-entry import licenses autoclean help exec node " ;;
  esac
  install="${install//-/}"
  native="${native//-/}"
  valueflags=" $(_safe_pkg_valueflags "$manager") "
  for a in "$@"; do
    case "$a" in
      -*=*) skip=0; continue ;;
      -*)
        skip=0
        case "$valueflags" in *" $a "*) skip=1 ;; esac
        [ "$skip" = 0 ] && _safe_pkg_dir_flag "$manager" "$a" > /dev/null && skip=1
        continue ;;
    esac
    n="$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')"
    n="${n//-/}"
    [ -z "$n" ] && continue
    inst=0
    case "$install" in *" $n "*) inst=1 ;; esac
    if [ "$inst" = 0 ] && [ "$manager" = "npm" ] && [ "${#n}" -ge 2 ]; then
      case "$install" in *" $n"*) inst=1 ;; esac
    fi
    if [ "$skip" = 1 ]; then
      skip=0
      [ "$inst" = 1 ] || continue
    fi
    seen=1
    # yarn v1 spells a global install as a subcommand; only the mutating ones
    # are install-class (refused in _safe_pkg_dispatch), `yarn global list` is not.
    if [ "$g" = 1 ]; then
      case "$n" in add|remove|upgrade) printf '%s\n' global ;; esac
      return 0
    fi
    if [ "$manager" = "yarn" ] && [ "$n" = "global" ]; then g=1; continue; fi
    case "$native" in *" $n "*) return 0 ;; esac
    if [ "$inst" = 1 ]; then printf '%s\n' "$n"; return 0; fi
  done
  if [ "$manager" = "yarn" ] && [ "$seen" = 0 ]; then
    for a in "$@"; do
      case "$a" in -v|--version|-h|--help) return 0 ;; esac
    done
    printf '%s\n' install
  fi
  return 0
}

# _safe_pkg_is_install manager [args...]
#   Succeeds when the command installs, adds, removes or updates packages.
_safe_pkg_is_install() {
  [ -n "$(_safe_pkg_subcmd "$@")" ]
}

# _safe_pkg_runner_specs manager [args...]
#   For the commands that download a package and run it (npx, pnpx, npm exec,
#   npm init|create, pnpm dlx|create, yarn dlx|create) prints the package
#   specs that will be fetched, one per line, and returns 0. Returns 1 for any
#   other command. The specs are candidates: malware-scan.js drops what is not
#   a registry package (paths, URLs, git) and what the registry does not know.
#   Where the parse is ambiguous, every reading is scanned:
#     The command word: listed value flags and directory flags have their value
#       skipped. A word after any other flag may be that flag's value or the
#       command, so it is tried as the command and the next word is tried too.
#       npm and pnpm still read the command after --, yarn does not. npm
#       accepts the abbreviations exe (exec), cr..creat (create), ini and
#       inn..inni (init); pnpm and yarn none (checked against npm 10.9 and
#       11, pnpm 9.15, 10 and 11, yarn 1.22).
#     -p/--package values are the packages; the first word after the flags is
#       then a command name, not a package. npm reads them anywhere before --,
#       also after the command name; pnpm before dlx (--package only, its
#       global -p is another flag) and among dlx's flags.
#     A word after a flag missing from the lists may be its value, so it is a
#       candidate and the next word is too; any number of such flags can come
#       first. A flag where a value was expected is treated the same way.
#     pnpm's -c (shell mode) takes no value; npm's -c/--call takes a script.
#     create adds the create- prefix the managers add (foo -> create-foo,
#       @scope/foo -> @scope/create-foo, @scope -> @scope/create).
_safe_pkg_runner_specs() {
  local manager="$1" valueflags a n mode skip=0 maybe=0 dd=0 found=1 pkgs="" nl="
"
  shift
  case "$manager" in
    npx) _safe_pkg_runner_tail npm exec "" 0 "$@"; return 0 ;;
    pnpx) _safe_pkg_runner_tail pnpm exec "" 0 "$@"; return 0 ;;
  esac
  valueflags=" $(_safe_pkg_valueflags "$manager") "
  while [ $# -gt 0 ]; do
    a="$1"; shift
    if [ "$dd" = 0 ]; then
      case "$skip:$a" in
        pkg:-*|1:-*) skip=0; maybe=1; continue ;;
        pkg:*) pkgs="$pkgs$a$nl"; skip=0; continue ;;
        1:*) skip=0; continue ;;
      esac
      case "$a" in
        --) [ "$manager" = yarn ] && break; dd=1; maybe=0; continue ;;
        --package=*) maybe=0; [ "$manager" = yarn ] || pkgs="$pkgs${a#*=}$nl"; continue ;;
        --package) maybe=0; [ "$manager" = yarn ] && maybe=1 || skip=pkg; continue ;;
        -*=*) maybe=0; continue ;;
        -*)
          maybe=1
          case "$valueflags" in *" $a "*) maybe=0; skip=1 ;; esac
          [ "$maybe" = 1 ] && _safe_pkg_dir_flag "$manager" "$a" > /dev/null && { maybe=0; skip=1; }
          continue ;;
      esac
    fi
    n="$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')"
    mode=""
    case "$manager:$n" in
      npm:exec|npm:exe|npm:x|pnpm:dlx|yarn:dlx) mode=exec ;;
      npm:init|npm:ini|npm:inn|npm:inni|npm:innit|npm:cr|npm:cre|npm:crea|npm:creat|npm:create|pnpm:create|yarn:create) mode=create ;;
    esac
    if [ -n "$mode" ]; then
      found=0
      _safe_pkg_runner_tail "$manager" "$mode" "$pkgs" "$dd" "$@"
    fi
    # A word that may be a flag's value: the next word may be the command.
    [ "$maybe" = 1 ] && [ "$dd" = 0 ] && { maybe=0; continue; }
    break
  done
  return "$found"
}

# _safe_pkg_runner_tail manager mode pkgs dashdash [args after the command word...]
#   The spec finder for one reading of the command word; see
#   _safe_pkg_runner_specs. pkgs holds the --package values read before the
#   command word, one per line; dashdash 1 means a -- came before it, so no
#   word is a flag.
_safe_pkg_runner_tail() {
  local manager="$1" mode="$2" pkgs="$3" dd="$4" valueflags a skip=0 maybe=0 found=0 pos="" nl="
"
  shift 4
  valueflags=" $(_safe_pkg_valueflags "$manager") "
  for a in "$@"; do
    if [ "$dd" = 0 ]; then
      case "$skip:$a" in
        pkg:-*|1:-*) skip=0; maybe=1; continue ;;
        pkg:*) pkgs="$pkgs$a$nl"; skip=0; continue ;;
        1:*) skip=0; continue ;;
      esac
      case "$manager:$a" in
        *:--) dd=1; [ "$found" = 1 ] && break; maybe=0; continue ;;
        npm:-p|npm:--package|pnpm:-p|pnpm:--package) maybe=0; skip=pkg; continue ;;
        npm:--package=*|npm:-p=*|pnpm:--package=*|pnpm:-p=*) maybe=0; pkgs="$pkgs${a#*=}$nl"; continue ;;
        npm:-c|npm:--call) maybe=0; skip=1; continue ;;
        *:-*=*|pnpm:-c) maybe=0; continue ;;
        *:-y|*:--yes|*:-n|*:--no|*:--no-install|*:--ignore-existing|*:-s|*:--shell-mode|*:--silent|*:-q|*:--quiet|*:--verbose|*:--json|*:--offline|*:--prefer-offline|*:-ws|*:--workspaces|*:--no-workspaces|*:--include-workspace-root|*:--no-color|*:--color|*:--no-fund|*:--no-audit) maybe=0; continue ;;
        *:-*)
          maybe=1
          case "$valueflags" in *" $a "*) maybe=0; skip=1 ;; esac
          continue ;;
      esac
    fi
    # npm reads flags after the command name too; only --package matters there.
    [ "$found" = 1 ] && continue
    pos="$pos$a$nl"
    if [ "$maybe" = 1 ] && [ "$dd" = 0 ]; then maybe=0; continue; fi
    found=1
    [ "$manager" = npm ] && [ "$dd" = 0 ] && continue
    break
  done
  if [ "$mode" = create ]; then
    local line rest scope
    printf '%s' "$pkgs"
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in
        @*/*) scope="${line%%/*}/"; rest="${line#*/}" ;;
        # `create @scope[@version]` runs @scope/create
        @*) rest="${line#@}"; scope="@${rest%%@*}/"; rest="${rest#"${rest%%@*}"}"
            printf '%s\n' "${scope}create$rest"; continue ;;
        *) scope=""; rest="$line" ;;
      esac
      printf '%s\n' "${scope}create-$rest"
      case "$rest" in create-*) printf '%s\n' "$line" ;; esac
    done <<SPECS_END
$pos
SPECS_END
    return 0
  fi
  if [ -n "$pkgs" ]; then printf '%s' "$pkgs"; else printf '%s' "$pos"; fi
  return 0
}

# _safe_pkg_runner_check manager [args...]
#   Runs before a download-and-run command. Not one of them: succeeds at once.
#   Otherwise checks the packages it would fetch against OSV (malware-scan.js
#   --specs) and fails, so the caller does not run the command, when one has a
#   MAL- advisory. A scan that cannot run warns, or blocks under
#   SAFE_PNPM_OSV_STRICT=1 / SAFE_PNPM_STRICT=1, like the install path.
_safe_pkg_runner_check() {
  local specs spec
  specs="$(_safe_pkg_runner_specs "$@")" || return 0
  set -- --specs
  while IFS= read -r spec; do
    [ -n "$spec" ] && set -- "$@" "$spec"
  done <<SPECS_END
$specs
SPECS_END
  [ $# -gt 1 ] || return 0
  _safe_pkg_malware_scan "$@"
}

_safe_pkg_prescan() {
  local manager="$1"
  local lockfile="$2"
  # socket_flag is set to 1 by the wrapper when `--socket` was passed on the
  # command line. Combined with SAFE_PNPM_ENABLE_SOCKET, it opts this run into
  # the Socket behavioral scan (off by default).
  local socket_flag="${3:-0}"
  local interactive=0
  [ -t 0 ] && interactive=1

  # Socket is opt-in: it needs an authenticated account and makes a network
  # call, so it only runs when the user enables it globally
  # (SAFE_PNPM_ENABLE_SOCKET=1) or per-invocation (`--socket`).
  local socket_enabled=0
  if [ "${SAFE_PNPM_ENABLE_SOCKET:-}" = "1" ] || [ "$socket_flag" = "1" ]; then
    socket_enabled=1
  fi
  if [ "$socket_enabled" -eq 1 ]; then
    _safe_pkg_socket_scan "$interactive" || return 1
  fi
}

# _safe_pkg_audit manager lockfile snapdir tmpdir
#   Runs the manager's CVE audit on the tree phase 1 resolved, so a package
#   passed to `add` is covered. Returns 1 to block. A non-zero exit means either
#   advisories or that the audit itself could not run (offline, registry
#   error); the output is shown so the user can tell which. Interactive runs
#   prompt, non-interactive runs warn and continue, SAFE_PNPM_STRICT=1 blocks.
#
#   Runs on the host, so it never touches the project: it audits a throwaway
#   copy of the post-fetch snapshot plus the registry config (.npmrc from the
#   sandbox, and .yarnrc without its yarn-path line). pnpm also skips the
#   project's .pnpmfile.cjs, which would otherwise run on the host.
_safe_pkg_audit() {
  local manager="$1" lockfile="$2" snapdir="$3" tmpdir="$4"
  [ -f "$snapdir/tree/$lockfile" ] || return 0

  local interactive=0
  [ -t 0 ] && interactive=1

  local auditdir audit_out audit_rc
  auditdir=$(mktemp -d) || return 1
  audit_out=$(mktemp) || { rm -rf "$auditdir"; return 1; }
  cp -R "$snapdir/tree/." "$auditdir/"
  [ -f "$tmpdir/.npmrc" ] && cp "$tmpdir/.npmrc" "$auditdir/.npmrc"
  [ -f "$tmpdir/.yarnrc" ] && command grep -v '^[[:space:]]*"\{0,1\}yarn-path' "$tmpdir/.yarnrc" > "$auditdir/.yarnrc"

  echo "→ $manager audit..." >&2
  case "$manager" in
    pnpm) (cd "$auditdir" && command pnpm audit --audit-level moderate --config.ignore-pnpmfile=true) >"$audit_out" 2>&1 ;;
    npm)  (cd "$auditdir" && command npm  audit --audit-level moderate) >"$audit_out" 2>&1 ;;
    yarn) (cd "$auditdir" && command yarn audit) >"$audit_out" 2>&1 ;;
  esac
  audit_rc=$?
  rm -rf "$auditdir"

  if [ "$audit_rc" -ne 0 ]; then
    tail -n 40 "$audit_out" >&2
    if [ "${SAFE_PNPM_STRICT:-}" = "1" ]; then
      rm -f "$audit_out"
      echo "✗ $manager audit failed or found issues. Blocking (SAFE_PNPM_STRICT=1)." >&2
      return 1
    fi
    if [ "$interactive" -eq 1 ]; then
      printf "⚠️  %s audit failed or found issues. Continue anyway? [y/N] " "$manager" >&2
      read -r _ans
      case "$_ans" in [Yy]*) ;; *) rm -f "$audit_out"; return 1 ;; esac
    else
      echo "⚠️  $manager audit failed or found issues — continuing in non-interactive mode." >&2
    fi
  fi
  rm -f "$audit_out"
}

# _safe_pkg_socket_scan interactive
#   Runs the Socket behavioral scan and applies safe-pnpm's failure semantics.
#
#   Three outcomes are distinguished, because "Socket says these packages are
#   bad" and "Socket could not tell us anything" warrant different responses:
#
#     pass     — continue.
#     findings — the scan ran and the report is unhealthy. Prompt when
#                interactive; warn and continue when not, matching the audit
#                layer.
#     failure  — the scan could not run (no token, network/API error, crash).
#                Warn and continue by default: Socket is an opt-in layer on
#                top of the audit and malware scans, so an expired token or an
#                offline laptop should not break installs.
#
#   SAFE_PNPM_SOCKET_STRICT=1 turns both findings and failures into hard blocks,
#   which is the setting for CI, where "the scan never ran" must not silently
#   look like a pass.
_safe_pkg_socket_scan() {
  local interactive="$1"
  local strict=0
  [ "${SAFE_PNPM_SOCKET_STRICT:-}" = "1" ] && strict=1
  [ "${SAFE_PNPM_STRICT:-}" = "1" ] && strict=1

  local socket_cmd="$HOME/.safe-pnpm/socket"
  local classifier="$HOME/.safe-pnpm/socket-classify.js"

  if [ ! -f "$socket_cmd" ] || [ ! -f "$classifier" ]; then
    # The scan was explicitly requested but cannot run at all.
    if [ "$strict" -eq 1 ]; then
      echo "✗ Socket scan requested but not installed — run \`safe-pnpm setup\` (SAFE_PNPM_SOCKET_STRICT=1)." >&2
      return 1
    fi
    echo "⚠️  Socket scan requested but not installed — skipping. Run \`safe-pnpm setup\`." >&2
    return 0
  fi

  echo "→ Socket behavioral scan..." >&2

  local out rc verdict reason
  out=$(mktemp)
  # --report waits for the scan to finish and applies the org policy; without it
  # `scan create` only uploads the manifest and can never surface findings.
  "$socket_cmd" scan create . --report --json --no-spinner --no-banner \
    >"$out" 2>/dev/null
  rc=$?

  reason=$(node "$classifier" "$out" "$rc" 2>&1)
  verdict=$?
  rm -f "$out"

  case "$verdict" in
    0)
      return 0
      ;;
    3)
      if [ "$strict" -eq 1 ]; then
        echo "✗ $reason Blocking (SAFE_PNPM_SOCKET_STRICT=1)." >&2
        return 1
      fi
      if [ "$interactive" -eq 1 ]; then
        printf "⚠️  %s Continue anyway? [y/N] " "$reason" >&2
        read -r _ans
        case "$_ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
      fi
      echo "⚠️  $reason Continuing in non-interactive mode." >&2
      return 0
      ;;
    *)
      if [ "$strict" -eq 1 ]; then
        echo "✗ $reason Blocking (SAFE_PNPM_SOCKET_STRICT=1)." >&2
        return 1
      fi
      # A failed scan is not evidence of a problem, so it never prompts — it
      # only tells the user the layer did not run.
      echo "⚠️  $reason Continuing without Socket results." >&2
      return 0
      ;;
  esac
}

# _safe_pkg_malware_scan lockfile
# _safe_pkg_malware_scan --specs spec...
#   Checks every name@version in the lockfile the fetch phase resolved against
#   OSV's malicious-package advisories (malware-scan.js). It runs between the
#   phases, so no package code has run yet and packages being added in this
#   install are covered, not just the ones already locked.
#
#     pass     — continue.
#     findings — always block. A MAL- advisory marks that exact version as
#                malware; unlike an audit finding there is nothing to weigh.
#     failure  — the scan could not run (OSV unreachable, unreadable lockfile,
#                scanner not installed). Warn and continue, as the Socket layer
#                does; SAFE_PNPM_OSV_STRICT=1 blocks instead, for CI.
_safe_pkg_malware_scan() {
  local scanner="$HOME/.safe-pnpm/malware-scan.js"
  local reason verdict

  if [ -f "$scanner" ]; then
    echo "→ Malware scan (OSV)..." >&2
    reason=$(node "$scanner" "$@" 2>&1)
    verdict=$?
  else
    reason="Malware scan not installed — run \`safe-pnpm setup\`."
    verdict=4
  fi

  case "$verdict" in
    0)
      echo "✓ $reason" >&2
      return 0
      ;;
    3)
      echo "✗ $reason" >&2
      if [ "$1" = "--specs" ]; then
        echo "✗ safe-pnpm: not running it; no package code was executed." >&2
      else
        echo "✗ safe-pnpm: install blocked; nothing was built or copied back." >&2
      fi
      return 1
      ;;
  esac
  if [ "${SAFE_PNPM_OSV_STRICT:-}" = "1" ]; then
    echo "✗ $reason Blocking (SAFE_PNPM_OSV_STRICT=1)." >&2
    return 1
  fi
  if [ "${SAFE_PNPM_STRICT:-}" = "1" ]; then
    echo "✗ $reason Blocking (SAFE_PNPM_STRICT=1)." >&2
    return 1
  fi
  echo "⚠️  $reason Continuing without it." >&2
  return 0
}

# _safe_pkg_is_global [args...]
#   True when the args ask for a global install (-g, a short-flag cluster
#   containing g, --global, --global=true, --location=global, --location global). The sandbox
#   writes to the container's own global prefix, which is thrown away, so a
#   global install through the wrapper would exit 0 and change nothing.
_safe_pkg_is_global() {
  local prev="" a
  # yarn v1 spells it as a subcommand: yarn global add|remove|upgrade
  local first="" second=""
  for a in "$@"; do
    case "$a" in
      -*) ;;
      *) if [ -z "$first" ]; then first="$a"; else second="$a"; break; fi ;;
    esac
  done
  if [ "$first" = "global" ]; then
    case "$second" in add|remove|upgrade) return 0 ;; esac
  fi
  for a in "$@"; do
    case "$a" in
      --) return 1 ;;
      --global|--global=true|--global=1|--location=global) return 0 ;;
      --*) ;;
      -*g*) return 0 ;;
    esac
    [ "$prev" = "--location" ] && [ "$a" = "global" ] && return 0
    prev="$a"
  done
  return 1
}

# _safe_pkg_dir_flag manager [args...]
#   Prints the first flag that points the package manager at another
#   directory and succeeds; fails when there is none. The scan and the sandbox
#   use this directory's lockfile and manifests, so an install pointed
#   elsewhere would not be the tree that was checked. npm (nopt) and pnpm
#   strip any number of leading dashes and then try the name as a long option
#   and as a cluster of single-letter flags, so -prefix, ---dir and --DC all
#   count. Spellings refused, each also as --flag=DIR (checked against
#   npm 10.9, pnpm 9.15 and 10.33, yarn 1.22):
#     npm   -C, --prefix and its abbreviation --prefi, a cluster with C (-DC)
#     pnpm  -C, --dir, --prefix/--prefi, --lockfile-dir and its older name
#           --lockfile-directory with every prefix of it the parser expands,
#           --shrinkwrap-directory, a cluster with C, and --config.dir,
#           --config.prefix, --config.lockfile-dir in any key spelling
#           (lockfileDir, lockfile_dir). pnpm rejects --lockfile-d and
#           --lockfile-di as ambiguous; they are refused all the same.
#     yarn  --cwd
#   No long option of either parser has a capital C, so any name of letters
#   only with a C in it is a cluster that sets -C. Words after -- are
#   arguments, not flags.
_safe_pkg_dir_flag() {
  local manager="$1" a name key
  shift
  for a in "$@"; do
    case "$a" in
      --) return 1 ;;
      -*) ;;
      *) continue ;;
    esac
    name="${a%%=*}"
    if [ "$manager" = "yarn" ]; then
      [ "$name" = "--cwd" ] || continue
    else
      name="${name#"${name%%[!-]*}"}"
      case "$manager:$name" in
        npm:prefi|npm:prefix) ;;
        pnpm:dir|pnpm:prefi|pnpm:prefix|pnpm:shrinkwrap-directory) ;;
        pnpm:lockfile-d|pnpm:lockfile-di|pnpm:lockfile-dir|pnpm:lockfile-dire|pnpm:lockfile-direc) ;;
        pnpm:lockfile-direct|pnpm:lockfile-directo|pnpm:lockfile-director|pnpm:lockfile-directory) ;;
        pnpm:config.*)
          key="$(printf '%s' "${name#config.}" | tr '[:upper:]' '[:lower:]' | tr -d '_-')"
          case "$key" in dir|prefix|lockfiledir) ;; *) continue ;; esac ;;
        *:|*:*[!A-Za-z]*) continue ;;
        *:*C*) ;;
        *) continue ;;
      esac
    fi
    printf '%s\n' "$a"
    return 0
  done
  return 1
}

# _safe_pkg_lockfile_dir_setting dir
#   Prints the file and key of the first setting in dir's .npmrc or
#   pnpm-workspace.yaml that moves pnpm's lockfile, and succeeds; fails when
#   there is none. Phase 1 would write the lockfile there, and the malware
#   scan and audit would read the old one. pnpm 9 and 10 read lockfile-dir
#   from .npmrc, pnpm 10 and later read lockfileDir from pnpm-workspace.yaml;
#   the image's pnpm hands off to the project's packageManager pin, so any of
#   them can run. The older .npmrc names are not read by pnpm 9-11 and are
#   refused all the same. Comment lines do not count.
_safe_pkg_lockfile_dir_setting() {
  local dir="$1" key
  if [ -f "$dir/.npmrc" ]; then
    key="$(grep -iE '^[[:space:]]*["'\'']?(lockfile-dir|lockfile-directory|shrinkwrap-directory)["'\'']?[[:space:]]*=' "$dir/.npmrc" | head -n 1 | grep -ioE 'lockfile-directory|shrinkwrap-directory|lockfile-dir' | head -n 1)"
    [ -n "$key" ] && { printf '%s %s\n' .npmrc "$key"; return 0; }
  fi
  if [ -f "$dir/pnpm-workspace.yaml" ]; then
    key="$(grep -iE '^[^#]*lockfile-?dir["'\'']?[[:space:]]*:' "$dir/pnpm-workspace.yaml" | head -n 1 | grep -ioE 'lockfile-?dir' | head -n 1)"
    [ -n "$key" ] && { printf '%s %s\n' pnpm-workspace.yaml "$key"; return 0; }
  fi
  return 1
}

# _safe_pkg_dispatch manager lockfile workspace_file manifest_files [pkg-manager-args...]
#   Shared entry point for the install-class path of every manager wrapper.
#   Strips the safe-pnpm-only `--socket` flag from the pass-through args (so it
#   never reaches the package manager), runs the prescan, then the sandboxed
#   install with the remaining args.
_safe_pkg_dispatch() {
  local manager="$1"
  local lockfile="$2"
  local workspace_file="$3"
  local manifest_files="$4"
  shift 4

  # Rotate positional params: pop each of the original args from the front and
  # either consume `--socket` or push it to the back. After $count iterations,
  # "$@" holds every arg except `--socket`, in order. This is space-safe in
  # sh/bash/zsh without relying on word-splitting.
  local socket_flag=0 count=$# arg
  while [ "$count" -gt 0 ]; do
    arg="$1"
    shift
    if [ "$arg" = "--socket" ]; then
      socket_flag=1
    else
      set -- "$@" "$arg"
    fi
    count=$((count - 1))
  done

  # npm, pnpm and yarn stop reading flags at --, and npm and pnpm at any
  # longer run of dashes too.
  for arg in "$@"; do
    case "$arg" in
      --*)
        [ -n "${arg//-/}" ] && continue
        echo "✗ safe-pnpm: $arg is not supported through the wrapper; the sandbox adds --ignore-scripts and its other flags after your arguments, and after $arg they would not be read as flags." >&2
        echo "  To run it without the safety checks: command $manager$(printf ' %q' "$@")" >&2
        return 1 ;;
    esac
  done

  if _safe_pkg_is_global "$@"; then
    echo "✗ safe-pnpm: global installs are not supported through the wrapper; the sandbox would install into a throwaway container and change nothing on this machine." >&2
    echo "  To install globally without the safety checks, run: command $manager$(printf ' %q' "$@")" >&2
    return 1
  fi

  local dir_flag
  if dir_flag="$(_safe_pkg_dir_flag "$manager" "$@")"; then
    echo "✗ safe-pnpm: $dir_flag is not supported through the wrapper; the scan checks this directory's lockfile, so an install in another directory would go unchecked." >&2
    echo "  cd into that directory and run the command there. To run it without the safety checks: command $manager$(printf ' %q' "$@")" >&2
    return 1
  fi

  _safe_pkg_prescan "$manager" "$lockfile" "$socket_flag" || return 1
  _safe_pkg_run "$manager" "$lockfile" "$workspace_file" "$manifest_files" "$@"
}

# _safe_pkg_strip_npmrc_auth path
#   Remove only credential-bearing lines from a copied .npmrc, leaving registry
#   URLs, scopes and hoisting config intact. Used between the fetch and build
#   phases so build-time lifecycle scripts never see a registry token.
_safe_pkg_strip_npmrc_auth() {
  local f="$1"
  [ -f "$f" ] || return 0
  # Matches _authToken, _auth, _password, and username lines in any scope/host
  # form (e.g. //registry.example.com/:_authToken=...).
  # .yarnrc (v1) writes `_authToken "x"` with no `=`; .yarnrc.yml uses
  # npmAuthToken/npmAuthIdent keys with `:`.
  grep -viE '(_authtoken|_auth|_password|username|npmauthtoken|npmauthident)[[:space:]]*[=:"[:space:]]' "$f" > "$f.clean" 2>/dev/null || : > "$f.clean"
  mv "$f.clean" "$f"
}

# Under rootless Docker or Podman, container uid 0 maps to the invoking user
# but any other uid maps to a subordinate uid, so files the container writes
# into the bind-mounted sandbox could not be deleted by that user. There the
# containers keep their default user: root in them is unprivileged on the
# host. Rootless iff SecurityOptions lists "name=rootless". Only when that
# query fails (Podman's own CLI has no such field) is Podman's
# Host.Security.Rootless asked. An unreadable answer counts as not rootless,
# so --user stays the default.
_safe_pkg_docker_rootless() {
  local opts podman
  if opts=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null); then
    case "$opts" in *'"name=rootless"'*) return 0 ;; esac
    return 1
  fi
  podman=$(docker info --format '{{.Host.Security.Rootless}}' 2>/dev/null) || return 1
  podman=${podman#"${podman%%[![:space:]]*}"}
  podman=${podman%"${podman##*[![:space:]]}"}
  [ "$podman" = "true" ]
}

# Prints the flags that make both containers run as the invoking user.
# `command id` skips any alias or function named id, and a non-numeric
# result is refused: docker reads `--user :` as root.
_safe_pkg_user_flags() {
  local u g
  u=$(command id -u 2>/dev/null); g=$(command id -g 2>/dev/null)
  case "$u" in ''|*[!0-9]*) u="" ;; esac
  case "$g" in ''|*[!0-9]*) g="" ;; esac
  if [ -z "$u" ] || [ -z "$g" ]; then
    echo "✗ safe-pnpm: could not read your user id (id -u / id -g); refusing to run the install container as root." >&2
    return 1
  fi
  if _safe_pkg_docker_rootless; then return 0; fi
  echo "--user $u:$g -e HOME=/app/.safe-home"
}

# _safe_pkg_run manager lockfile workspace_file manifest_files [pkg-manager-args...]
#   manager        — binary name (pnpm, npm, yarn)
#   lockfile       — lock file name (e.g. pnpm-lock.yaml)
#   workspace_file — sidecar workspace file to walk up for, or "" for none
#   manifest_files — space-separated list of files to copy into the sandbox
#   remaining args — passed through to the package manager inside Docker
#
# Two-phase isolation:
#   Phase 1 (fetch)  — network on, registry token available, --ignore-scripts.
#                      Resolves and downloads every dependency into a store under
#                      /app. No package code runs, so the token cannot leak.
#   Phase 2 (build)  — network off (--network none), token gone, .npmrc auth
#                      lines stripped. Lifecycle/build scripts run here against
#                      the already-populated store, with nothing left to steal.
#   Set SAFE_PNPM_BUILD_NETWORK=1 to keep network in phase 2 for packages whose
#   build genuinely needs it (e.g. esbuild, sharp); the token is still withheld.
_safe_pkg_run() {
  # zsh does not word-split unquoted parameters by default; the manifest list
  # ($manifest_files) and the docker flag lists below all rely on sh-style
  # splitting. localoptions reverts this when the function returns.
  [ -n "${ZSH_VERSION:-}" ] && setopt localoptions sh_word_split

  local manager="$1"
  local lockfile="$2"
  local workspace_file="$3"
  local manifest_files="$4"
  shift 4
  local subcmd
  subcmd="$(_safe_pkg_subcmd "$manager" "$@")"

  if ! docker info > /dev/null 2>&1; then
    if [ ! -t 0 ]; then
      # Non-interactive (CI, scripts): fail closed. Silently running native
      # here would execute untrusted lifecycle scripts on the host, defeating
      # the isolation guarantee. Require explicit opt-in to fall back.
      if [ "${SAFE_PNPM_ALLOW_NATIVE_FALLBACK:-}" = "1" ]; then
        echo "⚠️  safe-pnpm: Docker not running — SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 set, running native $manager." >&2
        command "$manager" "$@"; return
      fi
      echo "✗ safe-pnpm: Docker not running and no TTY — refusing native $manager (set SAFE_PNPM_ALLOW_NATIVE_FALLBACK=1 to override)." >&2
      return 1
    fi
    printf "⚠️  safe-pnpm: Docker not running. Use native %s? [y/N] " "$manager" >&2
    read -r _ans
    case "$_ans" in
      [Yy]*) command "$manager" "$@" ;;
      *)     return 1 ;;
    esac
    return
  fi

  local tmpdir snapdir
  tmpdir=$(mktemp -d) || return 1
  # Host-only, never mounted into a container: the workspace-member list and
  # the post-fetch manifest snapshots that copy-back reads from.
  snapdir=$(mktemp -d) || { rm -rf "$tmpdir"; return 1; }

  # tmpdir holds a copy of .npmrc (registry token). Run the sandbox in a
  # subshell whose EXIT trap removes both dirs, so Ctrl-C or a kill cannot
  # leave the token on disk. A trap in this function would be global in bash.
  (
    # Expanded now, not at trap time: bash unwinds the function's locals before
    # the EXIT trap fires, so a late $tmpdir would be empty and rm a no-op.
    trap "rm -rf '$tmpdir' '$snapdir'" EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    _safe_pkg_sandbox "$tmpdir" "$snapdir" "$manager" "$lockfile" "$workspace_file" "$manifest_files" "$@"
  )
}

# _safe_pkg_host_platform manager tmpdir saved
#
# Native optional dependencies (rollup, esbuild, ...) ship one package per
# platform, and the container picks the Linux one. A macOS host then fails with
# "Cannot find module @rollup/rollup-darwin-arm64". On macOS this also asks the
# package manager for the host's build, so it goes through the same malware
# scan and CVE audit as everything else (phase 1 runs no install scripts).
# Linux hosts match the container, so nothing changes there.
#   pnpm: supportedArchitectures, through pnpm-arch.js: in the sandbox copy of
#         pnpm-workspace.yaml for pnpm 11 and later, in the sandbox copy of
#         package.json for a project pinned to pnpm 10 or earlier (before 10.5
#         pnpm rejects a workspace file without packages, and 8 and 9 ignore
#         the setting there). The
#         setting is not read from flags or environment. A project's own
#         supportedArchitectures wins. The workspace file is never copied back;
#         package.json is saved to <saved> first and put back by
#         _safe_pkg_pnpm_arch_restore.
#   yarn: prints --ignore-platform (yarn 1 has no per-platform list), so every
#         platform's build is fetched.
#   npm:  unchanged. --os/--cpu replace the container's platform instead of
#         adding to it, and esbuild's install script in the (Linux) build
#         container then fails for want of its Linux package.
# Prints extra package-manager flags on stdout; may edit tmpdir. Best effort:
# without node or pnpm-arch.js it warns and the host build is missing.
_safe_pkg_host_platform() {
  local manager="$1" tmpdir="$2" saved="$3" os cpu
  read -r os cpu <<EOF_HP || return 0
$(_safe_pkg_host_os_cpu)
EOF_HP
  [ -n "$cpu" ] || return 0
  case "$manager" in
    pnpm)
      local helper="$HOME/.safe-pnpm/pnpm-arch.js"
      if [ ! -f "$helper" ]; then
        echo "⚠️  safe-pnpm: pnpm-arch.js missing, so native packages for $os are not fetched (run: safe-pnpm update)." >&2
      elif ! node "$helper" apply "$tmpdir" "$os" "$cpu" "$saved" >&2; then
        echo "⚠️  safe-pnpm: could not add $os to pnpm's supportedArchitectures, so native packages for $os are not fetched." >&2
      fi
      ;;
    yarn) printf '%s\n' "--ignore-platform" ;;
  esac
}

# Prints "OS CPU" in npm's names for a macOS host, nothing otherwise.
_safe_pkg_host_os_cpu() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  case "$(uname -m)" in
    arm64|aarch64) echo "darwin arm64" ;;
    x86_64)        echo "darwin x64" ;;
  esac
}

# _safe_pkg_pnpm_arch_restore file saved
#
# Takes the supportedArchitectures that _safe_pkg_host_platform put in the
# sandbox package.json back out of its snapshot <file>, so the project's own
# package.json is not changed by it. No-op when <saved> does not exist. Returns
# 1 when it fails; the snapshot must then not be copied back.
_safe_pkg_pnpm_arch_restore() {
  local file="$1" saved="$2"
  [ -f "$saved" ] || return 0
  if ! node "$HOME/.safe-pnpm/pnpm-arch.js" restore "$file" "$saved"; then
    echo "✗ safe-pnpm: could not take safe-pnpm's supportedArchitectures out of package.json; nothing copied back." >&2
    return 1
  fi
}

# _safe_pkg_npm_host_builds tmpdir hardening user_flags token_env
#
# npm cannot be asked for several platforms at once: --os/--cpu replace the
# container's platform, and then esbuild's install script in the build
# container finds no Linux package. So after phase 1 this adds the host's
# optional packages next to the Linux ones, by name and version from the
# lockfile (already malware-scanned and unchanged by this step), with
# --no-save and --ignore-scripts. Needs the registry token, so it runs before
# the credentials are stripped. Best effort: without host-specs.js (an old
# install) it warns and the host build is missing, as before.
_safe_pkg_npm_host_builds() {
  [ -n "${ZSH_VERSION:-}" ] && setopt localoptions sh_word_split
  local tmpdir="$1" hardening="$2" user_flags="$3" token_env="$4" os cpu
  read -r os cpu <<EOF_HB || return 0
$(_safe_pkg_host_os_cpu)
EOF_HB
  [ -n "$cpu" ] || return 0
  # .cjs because the copy sits next to the project's package.json: with
  # "type": "module" there, node would load a .js copy as an ES module, where
  # host-specs.js's require() is not defined.
  if ! cp "$HOME/.safe-pnpm/host-specs.js" "$tmpdir/.safe-host-specs.cjs" 2>/dev/null; then
    echo "⚠️  safe-pnpm: host-specs.js missing, so native packages for $os are not installed (run: safe-pnpm update)." >&2
    return 0
  fi
  # shellcheck disable=SC2086
  docker run --rm --cap-drop ALL $hardening $user_flags \
    -v "${tmpdir}:/app" \
    -w /app \
    $token_env \
    safe-pnpm:latest sh -c \
    'specs=$(node /app/.safe-host-specs.cjs $1 $2) || exit 1; [ -z "$specs" ] || npm install --no-save --ignore-scripts --force --cache /app/.safe-store -- $specs' \
    sh "$os" "$cpu"
  local rc=$?
  rm -f "$tmpdir/.safe-host-specs.cjs"
  return $rc
}

# _safe_pkg_sandbox tmpdir snapdir manager lockfile workspace_file manifest_files [args...]
#   Body of _safe_pkg_run; tmpdir/snapdir are created and removed by the caller.
_safe_pkg_sandbox() {
  [ -n "${ZSH_VERSION:-}" ] && setopt localoptions sh_word_split

  local tmpdir="$1" snapdir="$2" manager="$3" lockfile="$4" workspace_file="$5" manifest_files="$6"
  shift 6
  local subcmd
  subcmd="$(_safe_pkg_subcmd "$manager" "$@")"

  local workspace_root _cwd rel_path d
  _cwd="$(pwd)"
  workspace_root="$_cwd"
  rel_path=""

  if [ -n "$workspace_file" ]; then
    d="$_cwd"
    while [ "$d" != "$HOME" ] && [ "$d" != "/" ]; do
      if [ -f "$d/$workspace_file" ]; then
        workspace_root="$d"
        rel_path="${_cwd#${workspace_root}}"
        rel_path="${rel_path#/}"
        break
      fi
      d="$(dirname "$d")"
    done
  fi

  : > "$snapdir/members"

  (
    cd "$workspace_root" || exit 1
    for f in $manifest_files; do
      [ -f "$f" ] && cp "$f" "$tmpdir/"
    done
    if [ -n "$workspace_file" ] && [ -f "$workspace_file" ]; then
      find . -name package.json -not -path "*/node_modules/*" -mindepth 2 | while read -r pkg; do
        member="$(dirname "${pkg#./}")"
        mkdir -p "$tmpdir/$member"
        cp "$pkg" "$tmpdir/$member/"
        printf '%s\n' "$member" >> "$snapdir/members"
      done
    fi
  )

  local lockfile_setting
  if [ "$manager" = "pnpm" ] && lockfile_setting="$(_safe_pkg_lockfile_dir_setting "$tmpdir")"; then
    echo "✗ safe-pnpm: ${workspace_root}/${lockfile_setting%% *} sets ${lockfile_setting#* }, so pnpm would write the lockfile somewhere other than the one the scan checks. Remove the setting and run the command again." >&2
    return 1
  fi

  local workdir="/app${rel_path:+/$rel_path}"

  # Per-manager store/cache kept under /app so phase 2 resolves fully offline,
  # plus the phase-1 fetch flags and the phase-2 build command.
  # trust-lockfile goes through --config. because the image's pnpm hands off
  # to a packageManager pin, and pnpm before 11.3 rejects --trust-lockfile.
  local store_flag phase2_cmd
  case "$manager" in
    pnpm) store_flag="--config.store-dir=/app/.safe-store"
          phase2_cmd="install --offline --config.trust-lockfile=true $store_flag" ;;
    npm)  store_flag="--cache /app/.safe-store"
          phase2_cmd="rebuild $store_flag" ;;
    yarn) store_flag="--cache-folder /app/.safe-store"
          phase2_cmd="install --offline --force $store_flag" ;;
    *)    store_flag=""; phase2_cmd="" ;;
  esac

  # Limits for both containers: no setuid escalation and a bounded process
  # count (a fork bomb in a build script would otherwise take down the Docker
  # VM). Memory is opt-in because legitimate builds vary widely in what they need.
  local hardening="--security-opt no-new-privileges --pids-limit 1024"
  [ -n "${SAFE_PNPM_MEMORY:-}" ] && hardening="$hardening --memory ${SAFE_PNPM_MEMORY}"

  # Both containers run as the invoking user, not root (except under rootless
  # Docker or Podman, see _safe_pkg_docker_rootless). Files they create in
  # the sandbox are then owned by that user, so cleanup can delete them on
  # Linux (Docker Desktop on macOS hides root ownership), and a process that
  # escapes the container is an ordinary user. The image has no home dir for
  # an arbitrary uid, so HOME points inside the sandbox mount.
  local user_flags
  user_flags=$(_safe_pkg_user_flags) || return 1

  # Tokens are forwarded only into the fetch phase, where --ignore-scripts
  # guarantees no package code runs. They are never present during phase 2.
  local token_env=""
  [ -n "${NODE_AUTH_TOKEN:-}" ] && token_env="$token_env -e NODE_AUTH_TOKEN"
  [ -n "${NPM_TOKEN:-}" ]       && token_env="$token_env -e NPM_TOKEN"

  # Host platform's native optional dependencies (see _safe_pkg_host_platform).
  # Yarn needs its flag in phase 2 too, or --force would prune what phase 1 added.
  local host_flags
  host_flags=$(_safe_pkg_host_platform "$manager" "$tmpdir" "$snapdir/arch-saved.json") || return 1
  local phase2_host_flags=""
  [ "$manager" = "yarn" ] && phase2_host_flags="$host_flags"

  # --- Phase 1: fetch (network on, token available, scripts disabled) ---
  # shellcheck disable=SC2086
  docker run --rm --cap-drop ALL $hardening $user_flags \
    -v "${tmpdir}:/app" \
    -w "$workdir" \
    $token_env \
    safe-pnpm:latest "$manager" "$@" --ignore-scripts $store_flag $host_flags
  local phase1_rc=$?
  local rc=$phase1_rc

  # Known-malware check on the tree phase 1 resolved, before any package code
  # runs. A hit discards the sandbox: nothing is built or copied back.
  local fetched=0
  if [ "$phase1_rc" -eq 0 ]; then
    if _safe_pkg_malware_scan "$tmpdir/$lockfile"; then
      fetched=1
    else
      rc=1
    fi
  fi

  # pnpm `fetch` only populates the store and never builds node_modules; there
  # is nothing to run scripts for, so skip the build phase entirely.
  local run_build=1
  { [ "$manager" = "pnpm" ] && [ "$subcmd" = "fetch" ]; } && run_build=0

  # Snapshot manifests and lockfile before phase 2. Phase 1 ran no package
  # code, so these hold only the package manager's own edits (add/remove/
  # update). Phase 2 build scripts can rewrite anything under /app; a rewritten
  # package.json script or lockfile URL would run natively on the next host
  # command, so copy-back reads manifests from here, never from the sandbox.
  local m f
  if [ "$fetched" -eq 1 ]; then
    mkdir -p "$snapdir/tree"
    for f in package.json "$lockfile"; do
      [ -f "$tmpdir/$f" ] && cp "$tmpdir/$f" "$snapdir/tree/$f"
    done
    while IFS= read -r m; do
      if [ -f "$tmpdir/$m/package.json" ]; then
        mkdir -p "$snapdir/tree/$m"
        cp "$tmpdir/$m/package.json" "$snapdir/tree/$m/package.json"
      fi
    done < "$snapdir/members"
    if ! _safe_pkg_pnpm_arch_restore "$snapdir/tree/package.json" "$snapdir/arch-saved.json"; then
      fetched=0
      rc=1
    fi
  fi

  # CVE audit on the resolved tree, after the snapshot and before any build
  # script. A block discards the sandbox like a malware hit does.
  if [ "$fetched" -eq 1 ] && ! _safe_pkg_audit "$manager" "$lockfile" "$snapdir" "$tmpdir"; then
    fetched=0
    rc=1
  fi

  if [ "$fetched" -eq 1 ] && [ "$run_build" -eq 1 ] && [ -n "$phase2_cmd" ]; then
    # Host-platform builds for npm; needs the token, so before the strip below.
    case "$subcmd" in
      uninstall|un) ;;
      *) if [ "$manager" = "npm" ] && ! _safe_pkg_npm_host_builds "$tmpdir" "$hardening" "$user_flags" "$token_env"; then
           fetched=0; rc=1
         fi ;;
    esac
  fi

  if [ "$fetched" -eq 1 ] && [ "$run_build" -eq 1 ] && [ -n "$phase2_cmd" ]; then
    # Strip registry credentials before any build script can run.
    _safe_pkg_strip_npmrc_auth "$tmpdir/.npmrc"
    _safe_pkg_strip_npmrc_auth "$tmpdir/.yarnrc"

    local net_flag="--network none"
    [ "${SAFE_PNPM_BUILD_NETWORK:-}" = "1" ] && net_flag=""

    # --- Phase 2: build (no token, no .npmrc auth, network off by default) ---
    # shellcheck disable=SC2086
    docker run --rm --cap-drop ALL $hardening $user_flags $net_flag \
      -v "${tmpdir}:/app" \
      -w "$workdir" \
      safe-pnpm:latest "$manager" $phase2_cmd $phase2_host_flags
    rc=$?
  fi

  # Copy results back whenever the fetch succeeded and passed the malware scan —
  # the dependency tree exists even if a build script later failed, and the
  # non-zero rc still surfaces. A failed fetch leaves a partial/empty tree, so
  # nothing is copied there.
  # Only node_modules at the root and in pre-existing workspace members come
  # back, so phase 2 cannot plant node_modules elsewhere in the project.
  if [ "$fetched" -eq 1 ]; then
    _safe_pkg_copy_modules "$tmpdir" "" "$workspace_root" || rc=1
    while IFS= read -r m; do
      _safe_pkg_copy_modules "$tmpdir" "$m" "$workspace_root" || rc=1
    done < "$snapdir/members"
    for f in package.json "$lockfile"; do
      [ -f "$snapdir/tree/$f" ] && cp "$snapdir/tree/$f" "${workspace_root}/$f"
    done
    while IFS= read -r m; do
      [ -f "$snapdir/tree/$m/package.json" ] && cp "$snapdir/tree/$m/package.json" "${workspace_root}/$m/package.json"
    done < "$snapdir/members"
  fi

  return $rc
}

# _safe_pkg_copy_modules tmpdir member workspace_root
#
# Copies <tmpdir>/<member>/node_modules to the same place under workspace_root
# (member "" is the root). The sandbox tree is untrusted after phase 2, so the
# source must resolve to exactly that path: a node_modules, or a member dir,
# swapped for a symlink could otherwise pull in files from anywhere the link
# points. Returns 1 when it refuses.
#
# Links inside node_modules are copied as links (-R): pnpm's layout is built
# from them. macOS `cp -r` (undocumented there) follows links instead, turning
# each package into a plain copy cut off from its dependencies in .pnpm/, so
# the first import of one fails. Linux `cp -r` keeps links, so Linux CI never
# showed this. Kept links must stay inside the project; see link-check.js.
_safe_pkg_copy_modules() {
  local base="$1" member="$2" dest_root="$3"
  local rel="${member:+$member/}node_modules"
  local src="$base/$rel"
  [ -e "$src" ] || [ -L "$src" ] || return 0
  local want got
  want="$(cd "$base" && pwd -P)/$rel"
  got="$(cd "$src" 2>/dev/null && pwd -P)"
  if [ ! -d "$src" ] || [ -L "$src" ] || [ "$got" != "$want" ]; then
    echo "✗ safe-pnpm: sandbox $rel is not a plain directory; not copied back." >&2
    return 1
  fi
  _safe_pkg_links_ok "$base" "$rel" || return 1
  rm -rf "${dest_root:?}/$rel"
  cp -R "$src" "${dest_root}/$rel"
}

# _safe_pkg_links_ok base rel
#
# Fails closed: a missing checker or a tree it cannot read refuses copy-back.
_safe_pkg_links_ok() {
  local base="$1" rel="$2"
  local checker="$HOME/.safe-pnpm/link-check.js"
  if [ ! -f "$checker" ]; then
    echo "✗ safe-pnpm: link check not installed — run \`safe-pnpm update\`; $rel not copied back." >&2
    return 1
  fi
  if ! node "$checker" "$base" "$rel"; then
    echo "✗ safe-pnpm: sandbox $rel has links that point outside the project; not copied back." >&2
    return 1
  fi
}
