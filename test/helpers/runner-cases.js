// Commands that fetch a package and run it, and the specs the finder reports.
// The sh and PowerShell runner tests both read these tables. exec-npm: and
// exec-dlx: mark the specs malware-scan.js refuses when they name no version.
const RUNNERS = [
  ["npx", ["cowsay", "hi"], ["exec-npm:cowsay"]],
  ["npx", ["-y", "cowsay@1.5.0"], ["exec-npm:cowsay@1.5.0"]],
  ["npx", ["-p", "lodash", "-p", "cowsay", "cowsay"], ["exec-npm:lodash", "exec-npm:cowsay"]],
  ["npx", ["--package=foo", "bar"], ["exec-npm:foo"]],
  ["npx", ["--registry", "http://r", "cowsay"], ["exec-npm:cowsay"]],
  // an unlisted flag may take a value, so the next word is checked too
  ["npx", ["--future-flag", "val", "cowsay"], ["exec-npm:val", "exec-npm:cowsay"]],
  ["npx", ["--", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["exec", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["--prefix", "web", "exec", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["x", "--", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["init", "vite"], ["create-vite"]],
  ["npm", ["create", "@scope/foo"], ["@scope/create-foo"]],
  ["npm", ["create", "@scope"], ["@scope/create"]],
  ["npm", ["create", "@scope@2"], ["@scope/create@2"]],
  // already prefixed: npm adds create- again, pnpm and yarn do not
  ["npm", ["init", "create-foo"], ["create-create-foo", "create-foo"]],
  ["pnpm", ["dlx", "cowsay"], ["exec-dlx:cowsay"]],
  ["pnpm", ["-C", "web", "dlx", "cowsay"], ["exec-dlx:cowsay"]],
  ["pnpm", ["create", "vite@latest", "app"], ["create-vite@latest"]],
  ["yarn", ["dlx", "cowsay"], ["exec-dlx:cowsay"]],
  ["yarn", ["create", "react-app", "app"], ["create-react-app"]],
  // npm reads --package anywhere before --, also after the command name and
  // before the command word; pnpm reads it before dlx and in dlx's own flags
  ["npm", ["exec", "cowsay", "--package=foo"], ["exec-npm:foo"]],
  ["npm", ["exec", "cowsay", "--package", "foo"], ["exec-npm:foo"]],
  ["npm", ["--package=foo", "exec", "cowsay"], ["exec-npm:foo"]],
  ["npx", ["cowsay", "-p", "foo"], ["exec-npm:foo"]],
  ["pnpm", ["--package=foo", "dlx", "cowsay"], ["exec-dlx:foo"]],
  ["pnpm", ["dlx", "cowsay", "--package=foo"], ["exec-dlx:cowsay"]],
  ["pnpm", ["dlx", "-p", "foo", "-c", "cowsay"], ["exec-dlx:foo"]],
  // pnpm's -c (shell mode) takes no value; npm's -c (--call) does
  ["pnpm", ["dlx", "-c", "cowsay"], ["exec-dlx:cowsay"]],
  ["npm", ["exec", "-c", "cowsay hi", "--package", "foo"], ["exec-npm:foo"]],
  // pnpm's global -p is not --package
  ["pnpm", ["-p", "dlx", "cowsay"], ["exec-dlx:cowsay"]],
  // npm resolves unambiguous abbreviations of exec, init, create and innit
  ["npm", ["exe", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["cr", "vite"], ["create-vite"]],
  ["npm", ["cre", "vite"], ["create-vite"]],
  ["npm", ["creat", "vite"], ["create-vite"]],
  ["npm", ["ini", "vite"], ["create-vite"]],
  ["npm", ["inni", "vite"], ["create-vite"]],
  // every word after an unlisted flag may be its value
  [
    "npx",
    ["--proxy", "http://p", "--cafile", "ca.pem", "cowsay"],
    ["exec-npm:http://p", "exec-npm:ca.pem", "exec-npm:cowsay"],
  ],
  ["npm", ["exec", "--a", "x", "--b", "y", "cowsay"], ["exec-npm:x", "exec-npm:y", "exec-npm:cowsay"]],
  // before the command word: a flag value, a directory flag, an unlisted
  // flag (with or without a value), or --
  ["npm", ["-C", "web", "exec", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["--location", "project", "x", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["--future-flag", "exec", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["--future-flag", "val", "exec", "cowsay"], ["exec-npm:cowsay"]],
  ["npm", ["--", "exec", "cowsay"], ["exec-npm:cowsay"]],
  ["pnpm", ["--a", "v1", "--b", "v2", "dlx", "cowsay"], ["exec-dlx:cowsay"]],
  ["pnpm", ["--", "dlx", "cowsay"], ["exec-dlx:cowsay"]],
  ["yarn", ["--emoji", "false", "create", "vite"], ["create-vite"]],
  ["yarn", ["--future-flag", "create", "vite"], ["create-vite"]],
  // a flag where a value was expected may itself take the next word
  ["npm", ["--prefix", "--registry", "exec", "cowsay"], ["exec-npm:cowsay"]],
  ["npx", ["-p", "--yes", "cowsay"], ["exec-npm:cowsay"]],
  // pnpx is pnpm dlx
  ["pnpx", ["cowsay"], ["exec-dlx:cowsay"]],
  ["pnpx", ["--package=foo", "cowsay"], ["exec-dlx:foo"]],
];

// Not download-and-run: the finder must report nothing and return 1.
const OTHERS = [
  ["npm", ["install", "x"]],
  ["npm", ["run", "build"]],
  ["npm", ["--version"]],
  ["pnpm", ["exec", "cowsay"]],
  ["pnpm", ["add", "x"]],
  ["yarn", ["add", "x"]],
  ["yarn", []],
  // ambiguous npm abbreviations and pnpm abbreviations run nothing
  ["npm", ["e", "cowsay"]],
  ["npm", ["ex", "cowsay"]],
  ["pnpm", ["dl", "cowsay"]],
  // yarn takes the command from before --
  ["yarn", ["--", "create", "vite"]],
  ["npm", ["--prefix", "exec", "cowsay"]],
];

module.exports = { RUNNERS, OTHERS };
