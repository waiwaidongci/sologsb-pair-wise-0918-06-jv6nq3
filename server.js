const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  seals: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "POST /clocks/:id/seal",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "GET /seals"
];

const AMPLITUDE_MIN = 180;
const AMPLITUDE_MAX = 320;

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  db.clocks = db.clocks || [];
  db.adjustments = db.adjustments || [];
  db.retests = db.retests || [];
  db.seals = db.seals || [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function activeSeal(db, clockId) {
  return db.seals.find((item) => item.clockId === clockId && item.status === "active") || null;
}

// 最新复测是否覆盖当前最新调校：复测时间不早于调校时间，或复测显式关联该调校
function retestCoversAdjustment(retest, adjustment) {
  if (!retest) return false;
  if (!adjustment) return true;
  return retest.adjustmentId === adjustment.id || new Date(retest.testedAt) >= new Date(adjustment.createdAt);
}

// 封存门槛：当前调校后的最新复测，日差绝对值不超目标且振幅在 180–320
function sealEligibility(db, clock) {
  const adjustment = latestAdjustment(db, clock.id);
  const retest = latestRetest(db, clock.id);
  if (!retestCoversAdjustment(retest, adjustment)) {
    return { ok: false, reason: "pending_retest", retest, adjustment };
  }
  const rateOk = Math.abs(Number(retest.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
  const amplitudeOk = Number(retest.amplitude) >= AMPLITUDE_MIN && Number(retest.amplitude) <= AMPLITUDE_MAX;
  return { ok: rateOk && amplitudeOk, reason: rateOk && amplitudeOk ? null : "retest_not_qualified", retest, adjustment, rateOk, amplitudeOk };
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const seal = activeSeal(db, clock.id);
  const covered = retestCoversAdjustment(retest, adjustment);
  const qualified = covered && retest ? Boolean(retest.qualified) : false;
  const status = seal ? "sealed" : !covered ? "pending_retest" : qualified ? "qualified" : "unqualified";
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified,
    sealed: Boolean(seal),
    activeSeal: seal,
    sealable: !seal && sealEligibility(db, clock).ok,
    status
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    const sealed = url.searchParams.get("sealed");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    if (sealed !== null) {
      const expected = sealed === "true";
      data = data.filter((clock) => clock.sealed === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const seals = db.seals
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(b.sealedAt) - new Date(a.sealedAt));
    return send(res, 200, { data: { clock: clockSummary(db, clock), adjustments, retests, seals, latestRetest: latestRetest(db, clock.id) } });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    // 再次调校立即使当前封存失效，钟表回到待复测；旧封存保留可查
    const seal = activeSeal(db, clock.id);
    if (seal) {
      seal.status = "invalidated";
      seal.invalidatedAt = adjustment.createdAt;
      seal.invalidatedByAdjustmentId = adjustment.id;
    }
    await writeDb(db);
    return send(res, 201, { data: adjustment, invalidatedSeal: seal || null, clock: clockSummary(db, clock) });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const sealMatch = pathname.match(/^\/clocks\/([^/]+)\/seal$/);
  if (sealMatch && req.method === "POST") {
    const clock = findClock(db, sealMatch[1]);
    const body = await parseBody(req);
    required(body, ["deliveredBy", "sealTag"]);
    const active = activeSeal(db, clock.id);
    if (active) {
      const error = new Error(`钟表已封存（封签 ${active.sealTag}），再次调校前不能重复封存`);
      error.status = 409;
      throw error;
    }
    const eligibility = sealEligibility(db, clock);
    if (!eligibility.ok) {
      const reason = eligibility.reason === "pending_retest"
        ? "当前调校后尚无复测记录，钟表处于待复测状态"
        : `最新复测未达标（日差 ${eligibility.retest.dailyRateSeconds}s / 目标 ±${clock.targetDailyRateSeconds}s，振幅 ${eligibility.retest.amplitude}° / 要求 ${AMPLITUDE_MIN}–${AMPLITUDE_MAX}°）`;
      const error = new Error(`${reason}，不能登记封存`);
      error.status = 409;
      throw error;
    }
    // 封签全局唯一（含已失效封存），重复直接 409 且不写入
    if (db.seals.some((item) => item.sealTag === body.sealTag)) {
      const error = new Error(`封签 ${body.sealTag} 已存在，封存登记被拒绝`);
      error.status = 409;
      throw error;
    }
    const seal = {
      id: makeId("seal"),
      clockId: clock.id,
      sealTag: body.sealTag,
      deliveredBy: body.deliveredBy,
      retestId: eligibility.retest.id,
      sealedAt: new Date().toISOString(),
      status: "active",
      invalidatedAt: null,
      invalidatedByAdjustmentId: null,
      note: body.note || ""
    };
    db.seals.push(seal);
    await writeDb(db);
    return send(res, 201, { data: seal, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  const detailMatch = pathname.match(/^\/clocks\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const clock = findClock(db, detailMatch[1]);
    return send(res, 200, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/seals") {
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const data = db.seals
      .filter((item) => (!clockId || item.clockId === clockId) && (!status || item.status === status))
      .sort((a, b) => new Date(b.sealedAt) - new Date(a.sealedAt));
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
