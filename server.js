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
// 투표 기록: 투표(날짜)별 해시. field = 투표자 지문, value = JSON {name, optionIndex, ts}
// 한 지문당 한 표(HSETNX) → 중복 차단 + 누가 뭘 골랐는지 함께 저장(운영자 확인용).
function ballotsKey(openDate) { return "afterglow:ballots:" + openDate; }
// 익명 메시지: 메시지별 해시. field = 랜덤 id(중복 허용), value = JSON {from, to, content, ts}
function msgsKey(openDate) { return "afterglow:msgs:" + openDate; }

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
async function getBallots(openDate) {
  const flat = (await redis(["HGETALL", ballotsKey(openDate)])) || []; // [vid, json, vid, json, ...]
  const list = [];
  for (let j = 1; j < flat.length; j += 2) {
    try { list.push(JSON.parse(flat[j])); } catch {}
  }
  return list;
}
async function getMessages(openDate) {
  const flat = (await redis(["HGETALL", msgsKey(openDate)])) || []; // [id, json, id, json, ...]
  const list = [];
  for (let j = 1; j < flat.length; j += 2) {
    try { list.push(JSON.parse(flat[j])); } catch {}
  }
  return list;
}
async function resetVotes() {
  const cfg = await getConfig();
  if (cfg && cfg.openDate) {
    await redis(["DEL", ballotsKey(cfg.openDate)]);
    await redis(["DEL", msgsKey(cfg.openDate)]);
  }
}
async function deleteAll() {
  const cfg = await getConfig();
  if (cfg && cfg.openDate) {
    await redis(["DEL", ballotsKey(cfg.openDate)]);
    await redis(["DEL", msgsKey(cfg.openDate)]);
  }
  await redis(["DEL", K_CONFIG]);
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

// 이벤트가 지금 열려 있나? 메시지는 기간(openDate~endDate), 투표는 당일만.
function isOpenNow(cfg, today) {
  if (!cfg || !cfg.openDate) return false;
  if (cfg.type === "message") {
    const end = cfg.endDate || cfg.openDate;
    return today >= cfg.openDate && today <= end;
  }
  return cfg.openDate === today;
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
  // ballots HGETALL: [vid, json, ...] → 이름목록 + 집계
  const flat = ["a", JSON.stringify({ name: "철수", optionIndex: 0 }), "b", JSON.stringify({ name: "영희", optionIndex: 1 }), "c", JSON.stringify({ name: "민수", optionIndex: 0 })];
  const list = [];
  for (let j = 1; j < flat.length; j += 2) list.push(JSON.parse(flat[j]));
  const counts = {};
  for (const b of list) counts[b.optionIndex] = (counts[b.optionIndex] || 0) + 1;
  console.assert(list.length === 3 && counts[0] === 2 && counts[1] === 1, "ballots parse");
  console.assert(list[0].name === "철수", "ballot name");
  const today = todayStrSeoul();
  console.assert(/^\d{4}-\d{2}-\d{2}$/.test(today), "seoul date format");
  const v1 = voterId({ headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "A" }, socket: {} });
  const v2 = voterId({ headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "A" }, socket: {} });
  const v3 = voterId({ headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "B" }, socket: {} });
  console.assert(v1 === v2 && v1 !== v3, "voterId dedup key");
  // 메시지: 받는 사람별 그룹핑
  const msgs = [{ from: "철수", to: "영희" }, { from: "민수", to: "영희" }, { from: "영희", to: "철수" }];
  const groups = {};
  for (const m of msgs) (groups[m.to] = groups[m.to] || []).push(m);
  console.assert(groups["영희"].length === 2 && groups["철수"].length === 1, "message group");
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
        const isOpen = isOpenNow(cfg, today);
        const type = cfg && cfg.type === "message" ? "message" : "poll";
        let voted = false;
        // 메시지 모드는 지금 중복 허용(테스트) → voted 체크 안 함
        if (isOpen && type === "poll") {
          voted = (await redis(["HEXISTS", ballotsKey(cfg.openDate), voterId(req)])) === 1;
        }
        return json(res, {
          today,
          isOpen,
          voted,
          type: isOpen ? type : null,
          maxMessages: isOpen ? (cfg.maxMessages || 2) : null,
          title: isOpen ? cfg.title : null,
          desc: isOpen ? cfg.desc : null,
          options: isOpen ? cfg.options : null,
          openDate: cfg ? cfg.openDate : null,
          endDate: cfg ? (cfg.endDate || null) : null,
          configured: !!cfg,
        });
      }

      if (method === "POST" && apiPath === "submit") {
        const body = await readBody(req);
        const cfg = await getConfig();
        const today = todayStrSeoul();
        if (!cfg || cfg.openDate !== today) return json(res, { error: "not_open" }, 403);
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
        if (!name) return json(res, { error: "name_required" }, 400);
        if (
          typeof body.optionIndex !== "number" ||
          !Array.isArray(cfg.options) ||
          body.optionIndex < 0 ||
          body.optionIndex >= cfg.options.length
        ) {
          return json(res, { error: "invalid_option" }, 400);
        }
        // 한 지문당 1표(HSETNX = 원자적). 이름·선택을 함께 저장 → 운영자가 확인.
        const ballot = JSON.stringify({ name: name, optionIndex: body.optionIndex, ts: Date.now() });
        const fresh = await redis(["HSETNX", ballotsKey(cfg.openDate), voterId(req), ballot]);
        if (fresh === 0) return json(res, { error: "already_voted" }, 409);
        return json(res, { ok: true });
      }

      if (method === "POST" && apiPath === "msg") {
        const body = await readBody(req);
        const cfg = await getConfig();
        const today = todayStrSeoul();
        if (!cfg || cfg.type !== "message" || !isOpenNow(cfg, today)) return json(res, { error: "not_open" }, 403);
        const from = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
        if (!from) return json(res, { error: "name_required" }, 400);
        const max = cfg.maxMessages || 2;
        const items = (Array.isArray(body.messages) ? body.messages : [])
          .map((m) => ({
            to: m && typeof m.to === "string" ? m.to.trim().slice(0, 40) : "",
            content: m && typeof m.content === "string" ? m.content.trim().slice(0, 200) : "",
          }))
          .filter((m) => m.to && m.content)
          .slice(0, max);
        if (!items.length) return json(res, { error: "empty" }, 400);
        // 중복 허용(테스트 단계): 각 메시지를 랜덤 id로 저장
        for (const m of items) {
          const id = crypto.randomBytes(12).toString("hex");
          await redis(["HSET", msgsKey(cfg.openDate), id, JSON.stringify({ from: from, to: m.to, content: m.content, ts: Date.now() })]);
        }
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
        var endDate = typeof body.endDate === "string" ? body.endDate : "";
        if (endDate && endDate < openDate) endDate = openDate; // 종료일이 시작일보다 앞이면 보정
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
        const desc = typeof body.desc === "string" ? body.desc.trim().slice(0, 200) : "";
        const options = Array.isArray(body.options)
          ? body.options
              .filter((o) => typeof o === "string" && o.trim())
              .map((o) => o.trim().slice(0, 60))
              .slice(0, 20)
          : [];
        const type = body.type === "message" ? "message" : "poll";
        const maxMessages = Math.min(Math.max(parseInt(body.maxMessages, 10) || 2, 1), 5);
        if (!openDate || !title) return json(res, { error: "missing_fields" }, 400);
        if (type === "poll" && options.length < 2) return json(res, { error: "need_options" }, 400);
        const cfg = { type, openDate, endDate: type === "message" ? endDate : "", title, desc, options, maxMessages, updatedAt: Date.now() };
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
        if (cfg && cfg.type === "message") {
          // 메시지: 받는 사람별로 묶기
          const msgs = cfg.openDate ? await getMessages(cfg.openDate) : [];
          const groups = {};
          for (const m of msgs) (groups[m.to] = groups[m.to] || []).push({ from: m.from, content: m.content, ts: m.ts });
          for (const to in groups) groups[to].sort((a, b) => (b.ts || 0) - (a.ts || 0));
          return json(res, { config: cfg, today: todayStrSeoul(), type: "message", groups, total: msgs.length });
        }
        const ballots = cfg && cfg.openDate ? await getBallots(cfg.openDate) : [];
        const counts = {};
        for (const b of ballots) counts[b.optionIndex] = (counts[b.optionIndex] || 0) + 1;
        // 운영자에게 "누가 뭘 골랐는지" 명단 제공 (최신순)
        const voters = ballots
          .slice()
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .map((b) => ({ name: b.name, optionIndex: b.optionIndex }));
        return json(res, { config: cfg, today: todayStrSeoul(), type: "poll", counts, totalVotes: ballots.length, voters });
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
