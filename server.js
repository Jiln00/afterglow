// AFTERGLOW — anonymous, date-gated voting page.
// Storage: Upstash Redis (durable, survives restarts) when configured via
// env vars; otherwise a local data.json file so it still runs locally with
// zero setup. Votes are atomic Redis counters — no lost votes under a burst
// of simultaneous voters.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8888;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "260908";
const DATA_FILE = path.join(__dirname, "data.json");
const INDEX_FILE = path.join(__dirname, "index.html");

// ---- storage ----
const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useUpstash = !!(REST_URL && REST_TOKEN);
const K_CONFIG = "afterglow:config";
const K_VOTES = "afterglow:votes"; // redis hash: field = optionIndex, value = count

async function redis(cmd) {
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error("redis " + res.status + " " + (await res.text()));
  return (await res.json()).result;
}

// file fallback keeps a single {config, counts} object
function fileLoad() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { config: null, counts: {} };
  }
}
function fileSave(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

async function getConfig() {
  if (useUpstash) {
    const v = await redis(["GET", K_CONFIG]);
    return v ? JSON.parse(v) : null;
  }
  return fileLoad().config;
}
async function setConfig(cfg) {
  // ponytail: last-writer-wins on config — fine, only the single admin writes it
  if (useUpstash) return void (await redis(["SET", K_CONFIG, JSON.stringify(cfg)]));
  const d = fileLoad();
  d.config = cfg;
  fileSave(d);
}
async function addVote(i) {
  if (useUpstash) return void (await redis(["HINCRBY", K_VOTES, String(i), 1])); // atomic
  const d = fileLoad();
  d.counts[i] = (d.counts[i] || 0) + 1;
  fileSave(d);
}
async function getCounts() {
  if (useUpstash) {
    const flat = (await redis(["HGETALL", K_VOTES])) || []; // ["0","3","2","5",...]
    const counts = {};
    for (let j = 0; j < flat.length; j += 2) counts[flat[j]] = Number(flat[j + 1]);
    return counts;
  }
  return fileLoad().counts || {};
}
async function resetVotes() {
  if (useUpstash) return void (await redis(["DEL", K_VOTES]));
  const d = fileLoad();
  d.counts = {};
  fileSave(d);
}
async function deleteAll() {
  if (useUpstash) {
    await redis(["DEL", K_CONFIG]);
    await redis(["DEL", K_VOTES]);
    return;
  }
  fileSave({ config: null, counts: {} });
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function todayStrSeoul() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(chunks || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// ---- self-check: `node server.js --selftest` ----
if (process.argv.includes("--selftest")) {
  const flat = ["0", "3", "2", "5"];
  const counts = {};
  for (let j = 0; j < flat.length; j += 2) counts[flat[j]] = Number(flat[j + 1]);
  console.assert(counts["0"] === 3 && counts["2"] === 5, "HGETALL parse");
  const today = todayStrSeoul();
  console.assert(/^\d{4}-\d{2}-\d{2}$/.test(today), "seoul date format");
  console.log("selftest ok:", today, counts);
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  // ---- static: serve index.html for the root ----
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    fs.readFile(INDEX_FILE, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end("index.html not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(content);
    });
    return;
  }

  // ---- api ----
  if (pathname.startsWith("/api/")) {
    const apiPath = pathname.replace(/^\/api\/?/, "");
    const method = req.method;

    try {
      if (method === "GET" && apiPath === "state") {
        const cfg = await getConfig();
        const today = todayStrSeoul();
        const isOpen = !!(cfg && cfg.openDate === today);
        return json(res, {
          today,
          isOpen,
          title: isOpen ? cfg.title : null,
          desc: isOpen ? cfg.desc : null,
          options: isOpen ? cfg.options : null,
          openDate: cfg ? cfg.openDate : null,
          configured: !!cfg,
        });
      }

      if (method === "POST" && apiPath === "submit") {
        const body = await readBody(req);
        const cfg = await getConfig();
        const today = todayStrSeoul();
        if (!cfg || cfg.openDate !== today) return json(res, { error: "not_open" }, 403);
        if (
          typeof body.optionIndex !== "number" ||
          !Array.isArray(cfg.options) ||
          body.optionIndex < 0 ||
          body.optionIndex >= cfg.options.length
        ) {
          return json(res, { error: "invalid_option" }, 400);
        }
        await addVote(body.optionIndex);
        return json(res, { ok: true });
      }

      if (method === "POST" && apiPath === "admin/login") {
        const body = await readBody(req);
        if (body.password === ADMIN_PASSWORD) return json(res, { ok: true });
        return json(res, { ok: false }, 401);
      }

      if (method === "POST" && apiPath === "admin/save") {
        const body = await readBody(req);
        if (body.password !== ADMIN_PASSWORD) return json(res, { error: "unauthorized" }, 401);
        const openDate = typeof body.openDate === "string" ? body.openDate : "";
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
        const desc = typeof body.desc === "string" ? body.desc.trim().slice(0, 200) : "";
        const options = Array.isArray(body.options)
          ? body.options
              .filter((o) => typeof o === "string" && o.trim())
              .map((o) => o.trim().slice(0, 60))
              .slice(0, 20)
          : [];
        if (!openDate || !title) return json(res, { error: "missing_fields" }, 400);
        const cfg = { openDate, title, desc, options, updatedAt: Date.now() };
        await setConfig(cfg);
        return json(res, { ok: true, config: cfg });
      }

      if (method === "POST" && apiPath === "admin/config") {
        const body = await readBody(req);
        if (body.password !== ADMIN_PASSWORD) return json(res, { error: "unauthorized" }, 401);
        const cfg = await getConfig();
        return json(res, { config: cfg, today: todayStrSeoul() });
      }

      if (method === "POST" && apiPath === "admin/results") {
        const body = await readBody(req);
        if (body.password !== ADMIN_PASSWORD) return json(res, { error: "unauthorized" }, 401);
        const cfg = await getConfig();
        const counts = await getCounts();
        let total = 0;
        for (const k in counts) total += counts[k];
        return json(res, { config: cfg, today: todayStrSeoul(), counts, totalVotes: total });
      }

      if (method === "POST" && apiPath === "admin/reset") {
        const body = await readBody(req);
        if (body.password !== ADMIN_PASSWORD) return json(res, { error: "unauthorized" }, 401);
        await resetVotes();
        return json(res, { ok: true });
      }

      if (method === "POST" && apiPath === "admin/delete") {
        const body = await readBody(req);
        if (body.password !== ADMIN_PASSWORD) return json(res, { error: "unauthorized" }, 401);
        await deleteAll();
        return json(res, { ok: true });
      }

      return json(res, { error: "not_found" }, 404);
    } catch (err) {
      console.error("api error", err);
      return json(res, { error: "server_error" }, 500);
    }
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(
    "AFTERGLOW on http://localhost:" + PORT + " — storage: " + (useUpstash ? "Upstash Redis" : "local file")
  );
});
