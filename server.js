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
  "GET /clocks/:id/latest-retest",
  "POST /clocks/:id/seals",
  "GET /clocks/:id/seals",
  "GET /adjustments",
  "GET /retests",
  "GET /seals"
];

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
  // 兼容旧数据文件：补齐封签集合等数组
  db.clocks ??= [];
  db.adjustments ??= [];
  db.retests ??= [];
  db.seals ??= [];
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
  return db.seals
    .filter((item) => item.clockId === clockId && item.status === "valid")
    .sort((a, b) => new Date(b.sealedAt) - new Date(a.sealedAt))[0] || null;
}

function sealHistory(db, clockId) {
  return db.seals
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.sealedAt) - new Date(a.sealedAt));
}

// 封存交付的唯一结论来源：列表、历史、详情都通过它得出一致结论
function clockConclusion(db, clock) {
  const adjustment = latestAdjustment(db, clock.id);
  const retest = latestRetest(db, clock.id);
  const seal = activeSeal(db, clock.id);

  const target = Number(clock.targetDailyRateSeconds);
  const hasRate = retest && Number.isFinite(Number(retest.dailyRateSeconds));
  const hasAmplitude = retest && Number.isFinite(Number(retest.amplitude));
  const rateWithinTarget = hasRate && Math.abs(Number(retest.dailyRateSeconds)) <= target;
  const amplitudeWithinRange = hasAmplitude && Number(retest.amplitude) >= 180 && Number(retest.amplitude) <= 320;
  const retestAfterAdjustment =
    retest && (!adjustment || new Date(retest.testedAt) >= new Date(adjustment.createdAt));

  const retestMeetsCriteria = Boolean(
    retest && retestAfterAdjustment && rateWithinTarget && amplitudeWithinRange
  );

  let status;
  let statusReason;
  if (seal) {
    status = "sealed";
    statusReason = "已封存交付";
  } else if (!adjustment) {
    status = "unadjusted";
    statusReason = "尚未调校";
  } else if (!retest || !retestAfterAdjustment) {
    status = "pending-retest";
    statusReason = "最新调校后尚无复测结果";
  } else if (!retestMeetsCriteria) {
    status = "not-qualified";
    const reasons = [];
    if (!rateWithinTarget) reasons.push(`复测日差绝对值${Math.abs(Number(retest.dailyRateSeconds))}秒超过目标${target}秒`);
    if (!amplitudeWithinRange) reasons.push(`振幅${Number(retest.amplitude)}度不在180-320范围内`);
    statusReason = reasons.join("；");
  } else {
    status = "qualified";
    statusReason = "复测合格，可封存交付";
  }

  return {
    status,
    statusReason,
    sealed: Boolean(seal),
    activeSeal: seal,
    qualified: status === "sealed" || status === "qualified",
    retestMeetsCriteria,
    rateWithinTarget: Boolean(rateWithinTarget),
    amplitudeWithinRange: Boolean(amplitudeWithinRange),
    retestAfterLatestAdjustment: Boolean(retestAfterAdjustment),
    latestAdjustment: adjustment,
    latestRetest: retest
  };
}

function clockSummary(db, clock) {
  return { ...clock, ...clockConclusion(db, clock) };
}

// 封存前置条件：仅以当前最新调校后的最新复测为准
function assertSealable(db, clock) {
  const conclusion = clockConclusion(db, clock);
  const adjustment = conclusion.latestAdjustment;
  const retest = conclusion.latestRetest;

  if (conclusion.activeSeal) {
    const error = new Error(`该钟表已封存（封签 ${conclusion.activeSeal.sealTag}），再次调校后才能重新封存`);
    error.status = 409;
    throw error;
  }
  if (!adjustment) {
    const error = new Error("尚未调校，无法封存");
    error.status = 400;
    throw error;
  }
  if (!retest) {
    const error = new Error("调校后尚无复测记录，无法封存");
    error.status = 400;
    throw error;
  }
  if (!conclusion.retestAfterLatestAdjustment) {
    const error = new Error("最新调校后尚未复测，无法封存");
    error.status = 400;
    throw error;
  }
  if (!conclusion.rateWithinTarget) {
    const error = new Error(
      `最新复测日差绝对值${Math.abs(Number(retest.dailyRateSeconds))}秒超过目标${Number(clock.targetDailyRateSeconds)}秒，无法封存`
    );
    error.status = 400;
    throw error;
  }
  if (!conclusion.amplitudeWithinRange) {
    const error = new Error(`最新复测振幅${Number(retest.amplitude)}度不在180-320范围内，无法封存`);
    error.status = 400;
    throw error;
  }
  return conclusion;
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

  const clockDetailMatch = pathname.match(/^\/clocks\/([^/]+)$/);
  if (clockDetailMatch && req.method === "GET") {
    const clock = findClock(db, clockDetailMatch[1]);
    return send(res, 200, { data: clockSummary(db, clock) });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    const seals = sealHistory(db, clock.id);
    // 结论与列表、详情完全一致
    const summary = clockSummary(db, clock);
    return send(res, 200, {
      data: {
        clock: summary,
        adjustments,
        retests,
        seals,
        status: summary.status,
        statusReason: summary.statusReason,
        sealed: summary.sealed,
        activeSeal: summary.activeSeal,
        qualified: summary.qualified,
        latestRetest: summary.latestRetest
      }
    });
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

    // 封存后再次调校：封存立即失效，钟表回到待复测；旧封存保留可查
    const invalidatedSealIds = [];
    for (const seal of db.seals) {
      if (seal.clockId === clock.id && seal.status === "valid") {
        seal.status = "invalidated";
        seal.invalidatedAt = adjustment.createdAt;
        seal.invalidatedByAdjustmentId = adjustment.id;
        seal.invalidateReason = "封存后再次调校，封存自动失效，回到待复测";
        invalidatedSealIds.push(seal.id);
      }
    }

    await writeDb(db);
    return send(res, 201, {
      data: adjustment,
      invalidatedSealIds,
      clock: clockSummary(db, clock)
    });
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

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  const sealMatch = pathname.match(/^\/clocks\/([^/]+)\/seals$/);
  if (sealMatch && req.method === "POST") {
    const clock = findClock(db, sealMatch[1]);
    const body = await parseBody(req);
    required(body, ["sealTag", "deliveredBy"]);
    const sealTag = String(body.sealTag).trim();
    const deliveredBy = String(body.deliveredBy).trim();
    if (!sealTag) {
      const error = new Error("缺少字段：sealTag");
      error.status = 400;
      throw error;
    }
    if (!deliveredBy) {
      const error = new Error("缺少字段：deliveredBy");
      error.status = 400;
      throw error;
    }

    // 资格不满足直接拒绝，不产生任何写入
    const conclusion = assertSealable(db, clock);

    // 封签全局唯一：重复返回409且不写入
    const duplicated = db.seals.some((item) => item.sealTag === sealTag);
    if (duplicated) {
      const error = new Error(`封签 ${sealTag} 已存在，封签必须唯一`);
      error.status = 409;
      throw error;
    }

    const retest = conclusion.latestRetest;
    const sealedAt = new Date().toISOString();
    const seal = {
      id: makeId("seal"),
      clockId: clock.id,
      sealTag,
      deliveredBy,
      status: "valid",
      sealedAt,
      retestId: retest.id,
      adjustmentId: conclusion.latestAdjustment.id,
      note: body.note || "",
      // 封存时刻的复测快照，作为交付凭证固定下来
      snapshot: {
        targetDailyRateSeconds: Number(clock.targetDailyRateSeconds),
        dailyRateSeconds: Number(retest.dailyRateSeconds),
        amplitude: Number(retest.amplitude)
      }
    };
    db.seals.push(seal);
    await writeDb(db);
    return send(res, 201, { data: seal, clock: clockSummary(db, clock) });
  }

  if (sealMatch && req.method === "GET") {
    const clock = findClock(db, sealMatch[1]);
    const status = url.searchParams.get("status");
    let seals = sealHistory(db, clock.id);
    if (status !== null) seals = seals.filter((item) => item.status === status);
    return send(res, 200, { data: seals, activeSeal: activeSeal(db, clock.id) });
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

  if (req.method === "GET" && pathname === "/seals") {
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const sealed = url.searchParams.get("sealed");
    let data = db.seals.filter((item) => !clockId || item.clockId === clockId);
    if (status !== null) data = data.filter((item) => item.status === status);
    // sealed=true 仅返回当前有效封签，与 /clocks?sealed=true 口径一致
    if (sealed !== null) data = data.filter((item) => (item.status === "valid") === (sealed === "true"));
    data = data.sort((a, b) => new Date(b.sealedAt) - new Date(a.sealedAt));
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
