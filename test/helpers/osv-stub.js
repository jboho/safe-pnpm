// Stand-in for the OSV.dev API. It runs as its own process so tests can drive
// the scanner (and the wrappers that call it) with spawnSync without blocking
// the server.
//
// The first path segment of SAFE_PNPM_OSV_API picks a behaviour: ok, http500,
// badjson, short (one result too few), paged (MAL only on the second page) or
// nodetail (advisory lookups fail). Package names pick the answer: mal-* has a
// MAL advisory, withdrawn-* a withdrawn one, cve-* only a GHSA; anything else
// is clean. A scope is ignored (@acme/mal-x counts as mal-).
const http = require("node:http");
const { spawn } = require("node:child_process");

const MAL = "MAL-2099-1";
const WITHDRAWN = "MAL-2099-2";
const ADVISORIES = {
  [MAL]: { id: MAL, summary: "Malicious code in the package" },
  [WITHDRAWN]: {
    id: WITHDRAWN,
    summary: "Retracted report",
    withdrawn: "2099-01-01T00:00:00Z",
  },
};

function answer(query, mode) {
  const name = query.package.name.replace(/^@[^/]+\//, "");
  if (name.startsWith("mal-")) {
    if (mode === "paged" && !query.page_token) {
      return { vulns: [{ id: "GHSA-page-one" }], next_page_token: "page-2" };
    }
    return { vulns: [{ id: MAL }] };
  }
  if (name.startsWith("withdrawn-")) return { vulns: [{ id: WITHDRAWN }] };
  if (name.startsWith("cve-")) return { vulns: [{ id: "GHSA-cve-only" }] };
  return {};
}

function serve() {
  const server = http.createServer((req, res) => {
    const [, mode, ...rest] = req.url.split("/");
    const route = `/${rest.join("/")}`;
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (req.method === "POST" && route === "/v1/querybatch") {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        const { queries } = JSON.parse(data);
        // The real API rejects batches over 1000 the same way.
        if (queries.length > 1000) {
          send(400, { code: 3, message: "too many queries" });
        } else if (mode === "http500") {
          send(500, {});
        } else if (mode === "badjson") {
          send(200, "<html>");
        } else {
          const results = queries.map((q) => answer(q, mode));
          if (mode === "short") results.pop();
          send(200, { results });
        }
      });
      return;
    }

    const vuln = /^\/v1\/vulns\/(.+)$/.exec(route);
    if (req.method === "GET" && vuln) {
      const advisory = ADVISORIES[decodeURIComponent(vuln[1])];
      if (mode === "nodetail") send(500, {});
      else if (advisory) send(200, advisory);
      else send(404, {});
      return;
    }
    send(404, {});
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`${server.address().port}\n`);
  });
}

// Resolves to { url, stop } once the stub is listening.
function startOsvStub() {
  const child = spawn(process.execPath, [__filename], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (port) => {
      resolve({
        url: `http://127.0.0.1:${String(port).trim()}`,
        stop: () => child.kill(),
      });
    });
  });
}

if (require.main === module) {
  serve();
}

module.exports = { MAL, startOsvStub };
