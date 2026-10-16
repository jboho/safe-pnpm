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
];

module.exports = { RUNNERS, OTHERS };
