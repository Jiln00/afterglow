// AFTERGLOW — anonymous, date-gated voting page.
// Storage: Upstash Redis (durable). Votes are atomic Redis counters — no lost
// votes under a burst. One vote per IP+browser per poll (server-enforced).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8888;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "260908";
const INDEX_FILE = path.join(__dirname, "index.html");

// ---- storage: Upstash Redis ----
const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
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

async function getConfig() {
  const v = await redis(["GET", K_CONFIG]);
  return v ? JSON.parse(v) : null;
}
async function setConfig(cfg) {
  // ponytail: last-writer-wins on config — fine, only the single admin writes it
  await redis(["SET", K_CONFIG, JSON.stringify(cfg)]);
}
async function addVote(i) {
  await redis(["HINCRBY", K_VOTES, String(i), 1]); // atomic
}
async function getCounts() {
  const flat = (await redis(["HGETALL", K_VOTES])) || []; // ["0","3","2","5",...]
  const counts = {};
  for (let j = 0; j < flat.length; j += 2) counts[flat[j]] = Number(flat[j + 1]);
  return counts;
}
async function resetVotes() {
  await redis(["DEL", K_VOTES]);
  const cfg = await getConfig();
  if (cfg && cfg.openDate) await redis(["DEL", "afterglow:voters:" + cfg.openDate]);
}
async function deleteAll() {
  const cfg = await getConfig();
  if (cfg && cfg.openDate) await redis(["DEL", "afterglow:voters:" + cfg.openDate]);
  await redis(["DEL", K_CONFIG]);
  await redis(["DEL", K_VOTES]);
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

// 투표자 지문: 클라이언트 IP + 브라우저(UA) 해시. 같은 기기/브라우저는 같은 값.
function voterId(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xff || (req.socket && req.socket.remoteAddress) || "";
  const ua = req.headers["user-agent"] || "";
  return crypto.createHash("sha256").update(ip + "|" + ua).digest("hex").slice(0, 24);
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
  const v1 = voterId({ headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "A" }, socket: {} });
  const v2 = voterId({ headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "A" }, socket: {} });
  const v3 = voterId({ headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "B" }, socket: {} });
  console.assert(v1 === v2 && v1 !== v3, "voterId dedup key");
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
        let voted = false;
        if (isOpen) {
          voted = (await redis(["SISMEMBER", "afterglow:voters:" + cfg.openDate, voterId(req)])) === 1;
        }
        return json(res, {
          today,
          isOpen,
          voted,
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
        // 중복투표 방지: 같은 IP+브라우저는 이 투표에 1회만 집계 (SADD는 원자적)
        const fresh = await redis(["SADD", "afterglow:voters:" + cfg.openDate, voterId(req)]);
        if (fresh === 0) return json(res, { error: "already_voted" }, 409);
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
  console.log("AFTERGLOW on http://localhost:" + PORT + " — storage: Upstash Redis");
});
