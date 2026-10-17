// Commands that fetch a package and run it, and the specs the finder reports.
// The sh and PowerShell runner tests both read these tables.
const RUNNERS = [
  ["npx", ["cowsay", "hi"], ["cowsay"]],
  ["npx", ["-y", "cowsay@1.5.0"], ["cowsay@1.5.0"]],
  ["npx", ["-p", "lodash", "-p", "cowsay", "cowsay"], ["lodash", "cowsay"]],
  ["npx", ["--package=foo", "bar"], ["foo"]],
  ["npx", ["--registry", "http://r", "cowsay"], ["cowsay"]],
  // an unlisted flag may take a value, so the next word is checked too
  ["npx", ["--future-flag", "val", "cowsay"], ["val", "cowsay"]],
  ["npx", ["--", "cowsay"], ["cowsay"]],
  ["npm", ["exec", "cowsay"], ["cowsay"]],
  ["npm", ["--prefix", "web", "exec", "cowsay"], ["cowsay"]],
  ["npm", ["x", "--", "cowsay"], ["cowsay"]],
  ["npm", ["init", "vite"], ["create-vite"]],
  ["npm", ["create", "@scope/foo"], ["@scope/create-foo"]],
  ["npm", ["create", "@scope"], ["@scope/create"]],
  ["npm", ["create", "@scope@2"], ["@scope/create@2"]],
  // already prefixed: npm adds create- again, pnpm and yarn do not
  ["npm", ["init", "create-foo"], ["create-create-foo", "create-foo"]],
  ["pnpm", ["dlx", "cowsay"], ["cowsay"]],
  ["pnpm", ["-C", "web", "dlx", "cowsay"], ["cowsay"]],
  ["pnpm", ["create", "vite@latest", "app"], ["create-vite@latest"]],
  ["yarn", ["dlx", "cowsay"], ["cowsay"]],
  ["yarn", ["create", "react-app", "app"], ["create-react-app"]],
  // npm reads --package anywhere before --, also after the command name and
  // before the command word; pnpm reads it before dlx and in dlx's own flags
  ["npm", ["exec", "cowsay", "--package=foo"], ["foo"]],
  ["npm", ["exec", "cowsay", "--package", "foo"], ["foo"]],
  ["npm", ["--package=foo", "exec", "cowsay"], ["foo"]],
  ["npx", ["cowsay", "-p", "foo"], ["foo"]],
  ["pnpm", ["--package=foo", "dlx", "cowsay"], ["foo"]],
  ["pnpm", ["dlx", "cowsay", "--package=foo"], ["cowsay"]],
  ["pnpm", ["dlx", "-p", "foo", "-c", "cowsay"], ["foo"]],
  // pnpm's -c (shell mode) takes no value; npm's -c (--call) does
  ["pnpm", ["dlx", "-c", "cowsay"], ["cowsay"]],
  ["npm", ["exec", "-c", "cowsay hi", "--package", "foo"], ["foo"]],
  // pnpm's global -p is not --package
  ["pnpm", ["-p", "dlx", "cowsay"], ["cowsay"]],
  // npm resolves unambiguous abbreviations of exec, init, create and innit
  ["npm", ["exe", "cowsay"], ["cowsay"]],
  ["npm", ["cr", "vite"], ["create-vite"]],
  ["npm", ["cre", "vite"], ["create-vite"]],
  ["npm", ["creat", "vite"], ["create-vite"]],
  ["npm", ["ini", "vite"], ["create-vite"]],
  ["npm", ["inni", "vite"], ["create-vite"]],
  // every word after an unlisted flag may be its value
  [
    "npx",
    ["--proxy", "http://p", "--cafile", "ca.pem", "cowsay"],
    ["http://p", "ca.pem", "cowsay"],
  ],
  ["npm", ["exec", "--a", "x", "--b", "y", "cowsay"], ["x", "y", "cowsay"]],
  // before the command word: a flag value, a directory flag, an unlisted
  // flag (with or without a value), or --
  ["npm", ["-C", "web", "exec", "cowsay"], ["cowsay"]],
  ["npm", ["--location", "project", "x", "cowsay"], ["cowsay"]],
  ["npm", ["--future-flag", "exec", "cowsay"], ["cowsay"]],
  ["npm", ["--future-flag", "val", "exec", "cowsay"], ["cowsay"]],
  ["npm", ["--", "exec", "cowsay"], ["cowsay"]],
  ["pnpm", ["--a", "v1", "--b", "v2", "dlx", "cowsay"], ["cowsay"]],
  ["pnpm", ["--", "dlx", "cowsay"], ["cowsay"]],
  ["yarn", ["--emoji", "false", "create", "vite"], ["create-vite"]],
  ["yarn", ["--future-flag", "create", "vite"], ["create-vite"]],
  // a flag where a value was expected may itself take the next word
  ["npm", ["--prefix", "--registry", "exec", "cowsay"], ["cowsay"]],
  ["npx", ["-p", "--yes", "cowsay"], ["cowsay"]],
  // pnpx is pnpm dlx
  ["pnpx", ["cowsay"], ["cowsay"]],
  ["pnpx", ["--package=foo", "cowsay"], ["foo"]],
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
