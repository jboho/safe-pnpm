// Stand-in for the npm registry: every package has one version, 1.2.3. It
// runs as its own process, like osv-stub.js, so it still answers while a test
// blocks its own event loop in spawnSync.
const http = require("node:http");
const { spawn } = require("node:child_process");

function serve() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: "1.2.3" },
        versions: { "1.2.3": { name, version: "1.2.3" } },
      }),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`${server.address().port}\n`);
  });
}

// Resolves to { url, stop } once the stub is listening.
function startRegistryStub() {
  const child = spawn(process.execPath, [__filename], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (port) => {
      resolve({
        url: `http://127.0.0.1:${String(port).trim()}/`,
        stop: () => child.kill(),
      });
    });
  });
}

if (require.main === module) {
  serve();
}

module.exports = { startRegistryStub };
