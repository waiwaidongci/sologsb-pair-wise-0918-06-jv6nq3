// 封存交付闭环端到端测试：启动真实HTTP服务，断言全链路行为
const { spawn } = require("child_process");
const { rename } = require("fs/promises");
const path = require("path");

const BASE = "http://127.0.0.1:3021";
const DB = path.join(__dirname, "data", "db.json");
const DB_BAK = path.join(__dirname, "data", "db.json.bak");

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`, extra ?? "");
  }
}

async function req(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 使用演示初始数据（去掉现有db.json，服务会以initialData重建）
  await rename(DB, DB_BAK);
  const server = spawn(process.execPath, ["server.js"], { cwd: __dirname, stdio: "inherit" });
  await sleep(600);

  try {
    // --- 初始：演示钟表复测不合格（日差31 > 目标20）---
    let r = await req("GET", "/clocks/clock_demo");
    check("初始状态为 not-qualified", r.json.data.status === "not-qualified", r.json.data.status);
    check("初始 sealed=false", r.json.data.sealed === false);

    // 未合格尝试封存 -> 400
    r = await req("POST", "/clocks/clock_demo/seals", { sealTag: "S1", deliveredBy: "王" });
    check("不合格封存被400拒绝", r.status === 400, r.status);

    // 缺字段 -> 400
    r = await req("POST", "/clocks/clock_demo/seals", { sealTag: "S1" });
    check("缺少交付人400", r.status === 400, r.status);

    // --- 复测合格：日差12、振幅252 ---
    r = await req("POST", "/clocks/clock_demo/retests", { dailyRateSeconds: 12, amplitude: 252, note: "合格" });
    check("复测提交201", r.status === 201, r.status);
    check("复测后状态 qualified", r.json.clock.status === "qualified", r.json.clock.status);

    // 振幅越界：另一块钟表 振幅330
    r = await req("POST", "/clocks", { code: "C2", escapementType: "同轴", balanceFrequency: "28800vph", targetDailyRateSeconds: 10 });
    const c2 = r.json.data.id;
    await req("POST", `/clocks/${c2}/adjustments`, { currentDailyRateSeconds: 40, direction: "快", amount: "a" });
    r = await req("POST", `/clocks/${c2}/retests`, { dailyRateSeconds: 2, amplitude: 330 });
    r = await req("POST", `/clocks/${c2}/seals`, { sealTag: "S_C2", deliveredBy: "李" });
    check("振幅330封存被400拒绝", r.status === 400, r.status + " " + r.json.error);

    // 振幅边界180合格
    const r3 = await req("POST", "/clocks", { code: "C3", escapementType: "x", balanceFrequency: "21600vph", targetDailyRateSeconds: 5 });
    const c3 = r3.json.data.id;
    await req("POST", `/clocks/${c3}/adjustments`, { currentDailyRateSeconds: 30, direction: "慢", amount: "a" });
    r = await req("POST", `/clocks/${c3}/retests`, { dailyRateSeconds: -5, amplitude: 180 });
    check("边界复测qualified", r.json.clock.status === "qualified", r.json.clock.status);

    // 未调校钟表不能封存
    const r4 = await req("POST", "/clocks", { code: "C4", escapementType: "y", balanceFrequency: "28800vph" });
    const c4 = r4.json.data.id;
    r = await req("POST", `/clocks/${c4}/seals`, { sealTag: "S4", deliveredBy: "赵" });
    check("未调校封存400", r.status === 400, r.status);

    // --- 成功封存 clock_demo ---
    r = await req("POST", "/clocks/clock_demo/seals", { sealTag: "SEAL-001", deliveredBy: "王师傅", note: "交付" });
    check("合格封存201", r.status === 201, r.status);
    check("封存记录含交付人", r.json.data.deliveredBy === "王师傅");
    check("封存记录含快照", r.json.data.snapshot.dailyRateSeconds === 12 && r.json.data.snapshot.amplitude === 252);
    check("封存后钟表 sealed=true", r.json.clock.sealed === true && r.json.clock.status === "sealed");
    const sealId = r.json.data.id;

    // 重复封签 -> 409 且不写入（用在c3上，封签号相同）
    r = await req("POST", `/clocks/${c3}/seals`, { sealTag: "SEAL-001", deliveredBy: "钱" });
    check("重复封签409", r.status === 409, r.status);
    let sealsAll = (await req("GET", "/seals")).json.data;
    check("重复封签未写入(仍只有1条)", sealsAll.length === 1, sealsAll.length);

    // 已封存再次封存 -> 409
    r = await req("POST", "/clocks/clock_demo/seals", { sealTag: "SEAL-002", deliveredBy: "王师傅" });
    check("重复封存(已有有效封签)409", r.status === 409, r.status);
    sealsAll = (await req("GET", "/seals")).json.data;
    check("409未写入(仍只有1条)", sealsAll.length === 1, sealsAll.length);

    // sealed 筛选
    r = await req("GET", "/clocks?sealed=true");
    let sealedClocks = r.json.data;
    check("sealed=true 仅列出有效封存钟表", sealedClocks.length === 1 && sealedClocks[0].id === "clock_demo", sealedClocks.map((c) => c.id));
    r = await req("GET", "/clocks?sealed=false");
    check("sealed=false 不含已封存钟表", !r.json.data.some((c) => c.id === "clock_demo"));

    // c3 正常封存（不同封签）
    r = await req("POST", `/clocks/${c3}/seals`, { sealTag: "SEAL-003", deliveredBy: "钱师傅" });
    check("c3边界振幅封存201", r.status === 201, r.status);
    r = await req("GET", "/clocks?sealed=true");
    check("sealed=true 现有2块", r.json.data.length === 2, r.json.data.length);

    // --- 列表/详情/历史结论一致 ---
    const listView = (await req("GET", "/clocks")).json.data.find((c) => c.id === "clock_demo");
    const detailView = (await req("GET", "/clocks/clock_demo")).json.data;
    const hist = (await req("GET", "/clocks/clock_demo/history")).json.data;
    check("列表与详情 status 一致", listView.status === detailView.status && detailView.status === "sealed");
    check("历史顶层 status/sealed 一致", hist.status === "sealed" && hist.sealed === true);
    check("历史内嵌clock结论一致", hist.clock.status === "sealed" && hist.clock.activeSeal.id === sealId);
    check("历史activeSeal指向同一封签", hist.activeSeal.id === sealId);
    check("历史可查封存记录", hist.seals.length === 1 && hist.seals[0].sealTag === "SEAL-001");

    // --- 封存后再次调校：立即失效、回到待复测、旧封存保留 ---
    // 等待以保证时间戳严格递增
    await sleep(10);
    r = await req("POST", "/clocks/clock_demo/adjustments", { currentDailyRateSeconds: 14, direction: "慢针方向", amount: "复查微调0.1格" });
    check("再次调校201", r.status === 201, r.status);
    check("调校返回失效封签id", Array.isArray(r.json.invalidatedSealIds) && r.json.invalidatedSealIds[0] === sealId, JSON.stringify(r.json.invalidatedSealIds));
    check("调校后状态 pending-retest", r.json.clock.status === "pending-retest", r.json.clock.status);
    check("调校后 sealed=false", r.json.clock.sealed === false);
    check("调校后 activeSeal=null", r.json.clock.activeSeal === null);

    // sealed 筛选立即排除
    r = await req("GET", "/clocks?sealed=true");
    check("失效后sealed=true仅剩c3", r.json.data.length === 1 && r.json.data[0].id === c3, r.json.data.map((c) => c.id));

    // 旧封存保留可查且状态为 invalidated
    r = await req("GET", "/clocks/clock_demo/seals");
    check("旧封存保留可查", r.json.data.length === 1 && r.json.data[0].status === "invalidated", JSON.stringify(r.json.data));
    check("旧封存记录失效原因/调校id", r.json.data[0].invalidatedByAdjustmentId && r.json.data[0].invalidateReason);
    check("失效后activeSeal为null", r.json.activeSeal === null);

    r = await req("GET", "/seals?status=invalidated");
    check("全局seals可查失效封签", r.json.data.length === 1 && r.json.data[0].id === sealId);
    r = await req("GET", "/seals?sealed=true");
    check("全局seals?sealed=true仅有效封签", r.json.data.every((s) => s.status === "valid") && r.json.data.length === 1, r.json.data.length);

    // 失效后可重新走复测->封存，旧封签号不可复用
    r = await req("POST", "/clocks/clock_demo/retests", { dailyRateSeconds: -8, amplitude: 300 });
    check("重新复测后qualified", r.json.clock.status === "qualified", r.json.clock.status);
    r = await req("POST", "/clocks/clock_demo/seals", { sealTag: "SEAL-001", deliveredBy: "王师傅" });
    check("旧封签号复用仍409", r.status === 409, r.status);
    r = await req("POST", "/clocks/clock_demo/seals", { sealTag: "SEAL-004", deliveredBy: "王师傅" });
    check("新封签重新封存201", r.status === 201, r.status);
    check("重新封存后sealed=true", r.json.clock.sealed === true && r.json.clock.status === "sealed");
    r = await req("GET", "/clocks/clock_demo/seals");
    check("钟表下保留2条封存历史(1失效1有效)", r.json.data.length === 2 && r.json.data[0].status === "valid" && r.json.data[1].status === "invalidated", r.json.data.map((s) => s.status));

    // not-qualified 口径：封存钟表不应被视为不合格
    r = await req("GET", "/clocks/not-qualified");
    check("not-qualified 不含已封存钟表", !r.json.data.some((c) => c.id === "clock_demo" || c.id === c3));

    // 404
    r = await req("GET", "/clocks/no-such");
    check("不存在钟表404", r.status === 404, r.status);
  } catch (e) {
    failures++;
    console.error("测试异常:", e);
  } finally {
    server.kill();
    await sleep(200);
    await rename(DB_BAK, DB);
  }

  console.log(failures === 0 ? "\n全部测试通过 ✅" : `\n${failures} 项测试失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
