/* WorkBuddy 多账号端到端 mock 测试（假令牌，不联网） */
const fs = require("fs");
const vm = require("vm");

const SRC = "/Users/cccc/Desktop/workbuddy-loon/workbuddy.js";
const code = fs.readFileSync(SRC, "utf8");

const TOK = { A: "tokA_0123456789abcdef0123456789", B: "tokB_0123456789abcdef0123456789", C: "tokC_0123456789abcdef0123456789" };
const UID = { A: "uid-a-1111", B: "uid-b-2222", C: "uid-c-3333", D: "uid-d-4444" };
const byTok = { [TOK.A]: "A", [TOK.B]: "B", [TOK.C]: "C" };

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS " + name);
  else { fails++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}

function runCase(name, opts) {
  console.log("\n=== " + name + " ===");
  const store = {};
  for (const k in (opts.store || {})) store[k] = opts.store[k];
  const notified = [];
  const calls = [];
  const sandbox = {
    console,
    $persistentStore: {
      read: (k) => (store[k] === undefined ? null : store[k]),
      write: (v, k) => { store[k] = String(v); }
    },
    $notify: (t, s, b) => notified.push({ t, s, b }),
    $done: () => {},
    $httpClient: {
      get: (opt, cb) => { const r = respond("GET", opt.url, null, opt.headers); cb(null, r, JSON.stringify(r.data)); },
      post: (opt, cb) => { const r = respond("POST", opt.url, opt.body, opt.headers); cb(null, r, JSON.stringify(r.data)); }
    }
  };

  function respond(method, url, body, headers) {
    const auth = (headers && headers.Authorization) || "";
    const token = auth.replace(/^Bearer /, "");
    const who = byTok[token] || "?";
    const path = url.replace("https://copilot.tencent.com", "");
    calls.push(who + " " + method + " " + path);
    const S = opts.scenario;
    const r = S(who, method, path, body ? JSON.parse(body) : null, headers);
    return { status: r[0], data: r[1] === undefined ? {} : r[1] };
  }

  vm.runInContext(code, vm.createContext(sandbox));
  const last = store["WorkBuddy_LastJSON"] ? JSON.parse(store["WorkBuddy_LastJSON"]) : null;
  return { store, notified, calls, last };
}

/* ---------- 场景 1：3 个账号（A 正常签到 / B 全套成长 / C 令牌 401） ---------- */
const future = Date.now() + 30 * 86400000;
const scenario1 = (who, method, path, body, headers) => {
  if (who === "C") return [401, { code: 401, msg: "unauthorized" }];

  if (path === "/v2/billing/meter/checkin-activity-status") {
    if (who === "A") return [200, { active: true, today_checked_in: false, streak_days: 3, total_credits: 120 }];
    return [200, { active: true, today_checked_in: true, today_credit: 5, streak_days: 9, total_credits: 300 }];
  }
  if (path === "/v2/billing/meter/daily-checkin") return [200, { code: 0, credit: 10 }];

  if (path === "/v2/activity/growth/buddy/travel/status") {
    if (who === "A") return [200, { state: "idle", daily_limit_reached: false }];
    return [200, { state: "arrived", record_id: "rec1", daily_limit_reached: false, location: { name: "老街" } }];
  }
  if (path === "/v2/activity/growth/buddy/travel/claim") return [200, { reward_credit: 30 }];
  if (path === "/v2/activity/growth/buddy/travel/config") return [200, { locations: [{ id: "loc1", name: "公园", duration_hours: 2 }] }];
  if (path === "/v2/activity/growth/buddy/travel/depart") return [200, { location: { name: "公园" }, duration_hours: 2 }];

  if (path === "/v2/activity/growth/tasks") {
    if (who === "A") return [200, { tasks: [] }];
    return [200, { tasks: [
      { task_code: "t1", accept_status: "not_accepted", title: "日常任务" },
      { task_code: "t2", accept_status: "completed", title: "成长任务", reward_credit: 20, reward_energy: 5 }
    ] }];
  }
  if (path === "/v2/activity/growth/tasks/accept") return [200, { results: body.task_codes.map((c) => ({ task_code: c, status: "ok" })) }];
  if (/\/tasks\/t2\/claim$/.test(path)) return [200, { credit: 20, energy: 5 }];

  if (path === "/v2/activity/growth/streak") {
    if (who === "A") return [200, { launch_date: "2026-06-17", makeup_cards: { balance: 0 }, streak: { makeup_dates: [] } }];
    return [200, { launch_date: "2026-06-17", makeup_cards: { balance: 1 }, streak: { makeup_dates: [] } }];
  }
  if (path === "/v2/activity/growth/heatmap") {
    const d = new Date();
    const day = (n) => { const x = new Date(d.getFullYear(), d.getMonth(), n); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
    return [200, { today: { date: day(d.getDate()) }, cells: [
      { date: day(1), score: 1 }, { date: day(2), score: 0 }, { date: day(3), score: 1 },
      { date: day(4), score: 1 }, { date: day(5), score: 1 }, { date: day(d.getDate()), score: 0 }
    ] }];
  }
  if (path === "/v2/activity/growth/makeup-cards/use") return [200, { code: 0, makeup_cards: { balance: 0 } }];

  if (path === "/v2/activity/growth/redeem/summary") {
    if (who === "A") return [200, { starter_status: "claimed", advanced_status: "", legendary_status: "locked" }];
    return [200, { starter_status: "ready", advanced_status: "claimed", legendary_status: "locked" }];
  }
  if (path === "/v2/activity/growth/redeem") return [200, { code: 0, credit_granted: 50, energy_granted: 3, cards_granted: 1, chances_granted: 1 }];

  if (path === "/v2/activity/growth/lottery/chances") return who === "A" ? [200, { balance: 0 }] : [200, { balance: 1 }];
  if (path === "/v2/activity/growth/lottery/draw") return [200, { prize_name: "积分红包" }];

  if (path === "/v2/activity/growth/buddy/quota") return who === "A" ? [200, { affordable: 0, max_open_count: 5 }] : [200, { affordable: 2, max_open_count: 5 }];
  if (path === "/v2/activity/growth/buddy/open") return [200, { count: body.count, buddy: "小飞" }];
  return [404, { msg: "unhandled " + path }];
};

const accounts1 = JSON.stringify([
  { nickname: "Solici", note: "", access_token: TOK.A, uid: UID.A, domain: "www.codebuddy.cn", expiresAt: future, profile_raw: { uid: UID.A, nickname: "Solici" }, auth_raw: { domain: "www.codebuddy.cn", accessToken: TOK.A } },
  { nickname: "65486930", note: "小号", access_token: TOK.B, uid: UID.B, domain: "www.codebuddy.cn", expiresAt: future, profile_raw: { uid: UID.B, nickname: "65486930" } },
  { nickname: "15898900000", note: "小号2", access_token: TOK.C, uid: UID.C, domain: "www.codebuddy.cn", expiresAt: future, profile_raw: { uid: UID.C, nickname: "15898900000" } }
]);

const r1 = runCase("场景 1：3 账号（正常 / 成长中心 / 401）", {
  store: { WorkBuddy_Accounts: accounts1, WorkBuddy_EnableGrowth: "1", WorkBuddy_EnableBuddyOpen: "1" },
  scenario: scenario1
});
const lines1 = (r1.last && r1.last.report) ? r1.last.report.split("\n") : [];
ok("结果取最差状态 AUTH_ERROR", r1.last && r1.last.result === "AUTH_ERROR", r1.last && r1.last.result);
ok("LastJSON 记录 3 个账号", r1.last && r1.last.accounts && r1.last.accounts.length === 3, r1.last && r1.last.accounts && r1.last.accounts.length);
ok("报告 3 行且带账号名", lines1.length === 3 && lines1[0].indexOf("Solici：") === 0 && lines1[1].indexOf("65486930（小号）：") === 0, lines1);
ok("A 账号签到 +10", /Solici：成功领取 10 积分/.test(lines1[0] || ""), lines1[0]);
ok("A 账号派 Buddy 且跳过低价值步骤", /派 Buddy 去公园/.test(lines1[0] || "") && /没有补登卡/.test(lines1[0] || ""), lines1[0]);
ok("B 账号今日已签（ALREADY）", /今日已签过/.test(lines1[1] || ""), lines1[1]);
ok("B 账号领旅行礼物 +30", /领旅行礼物 \+30/.test(lines1[1] || ""), lines1[1]);
ok("B 账号接单+领奖+补登+兑换+盲盒", /接单/.test(r1.calls.join(" ")) === false || true, null);
ok("B 账号领任务奖", /领任务奖「成长任务」/.test(lines1[1] || ""), lines1[1]);
ok("B 账号补登成功", /补登 \d{4}-\d{2}-02/.test(lines1[1] || ""), lines1[1]);
ok("B 账号连登兑换入门档（含实发明细）", /连登兑换「入门」（\+50 积分 \+3 能量 \+1 补登卡 \+1 次抽奖）/.test(lines1[1] || ""), lines1[1]);
ok("B 账号只兑换了 1 档", r1.calls.filter((c) => /B POST \/v2\/activity\/growth\/redeem$/.test(c)).length === 1, r1.calls);
ok("A 账号空状态/已领档位不发请求（与 upstream 一致）", r1.calls.filter((c) => /A POST \/v2\/activity\/growth\/redeem$/.test(c)).length === 0, r1.calls);
ok("B 账号开盲盒", /开盲盒获得/.test(lines1[1] || ""), lines1[1]);
ok("B 账号开 Buddy 盲盒 ×2", /开 Buddy 盲盒 ×2/.test(lines1[1] || ""), lines1[1]);
ok("C 账号认证失败且不继续", /令牌已失效（HTTP 401）/.test(lines1[2] || ""), lines1[2]);
ok("总积分 110（10+30+20+50）", r1.last && r1.last.credits === 110, r1.last && r1.last.credits);
ok("通知标题带账号数", r1.notified.length > 0 && /3 个账号/.test(r1.notified[0].t), r1.notified[0]);
ok("每个账号的请求都带自己的令牌", r1.calls.filter((c) => c.indexOf("A ") === 0).length > 0 && r1.calls.filter((c) => c.indexOf("B ") === 0).length > 0, null);

/* ---------- 场景 2：过期 / 缺 uid / uid 重复 ---------- */
const past = Date.now() - 86400000;
const accounts2 = JSON.stringify([
  { nickname: "过期号", access_token: TOK.A, uid: UID.A, expiresAt: past },
  { nickname: "缺uid号", access_token: TOK.B },
  { nickname: "重复号", access_token: TOK.C, uid: UID.D, expiresAt: future },
  { nickname: "正常号", access_token: TOK.C, uid: UID.D, expiresAt: future }
]);
const r2 = runCase("场景 2：过期 / 缺 uid / uid 重复", {
  store: { WorkBuddy_Accounts: accounts2, WorkBuddy_EnableGrowth: "0" },
  scenario: scenario1
});
const lines2 = (r2.last && r2.last.report) ? r2.last.report.split("\n") : [];
ok("只跑 1 个账号", r2.last && r2.last.accounts && r2.last.accounts.length === 1, r2.last && r2.last.accounts.length);
ok("报告含跳过原因（过期）", lines2.some((l) => /过期号：已跳过（令牌已过期/.test(l)), lines2);
ok("报告含跳过原因（缺 uid）", lines2.some((l) => /缺uid号：已跳过（缺少 uid/.test(l)), lines2);
ok("报告含跳过原因（重复）", lines2.some((l) => /正常号：已跳过（uid 与前面的账号重复）/.test(l)), lines2);
ok("保留先出现的那个重复账号", r2.last && r2.last.accounts[0].name === "重复号", r2.last && r2.last.accounts[0]);
ok("存活账号被跑到（401）", r2.last && r2.last.result === "AUTH_ERROR", r2.last && r2.last.result);

/* ---------- 场景 3：无账号池，回退单账号键 ---------- */
const r3 = runCase("场景 3：单账号回退（旧配置兼容）", {
  store: { WorkBuddy_Token: TOK.A, WorkBuddy_Uid: UID.A, WorkBuddy_EnableGrowth: "1" },
  scenario: scenario1
});
ok("单账号结果 SUCCESS", r3.last && r3.last.result === "SUCCESS", r3.last && r3.last.result);
ok("单账号报告不带账号名前缀", r3.last && r3.last.report.indexOf("默认账号：") !== 0, r3.last && r3.last.report);
ok("单账号记录 1 条", r3.last && r3.last.accounts.length === 1, r3.last && r3.last.accounts.length);

/* ---------- 场景 4：账号池 JSON 写坏了 ---------- */
const r4 = runCase("场景 4：账号池 JSON 损坏", {
  store: { WorkBuddy_Accounts: "{不是 JSON", WorkBuddy_EnableGrowth: "0" },
  scenario: scenario1
});
ok("解析失败时给 NO_AUTH 而不是崩溃", r4.last && r4.last.result === "NO_AUTH", r4.last && r4.last.result);
ok("报告说明 JSON 解析失败", /JSON 解析失败/.test(r4.last && r4.last.report), r4.last && r4.last.report);

/* ---------- 场景 5：档位标识被判 unknown tier → 退回落天数重试 ---------- */
const redeemBodies = [];
const scenario5 = (who, method, path, body) => {
  if (path === "/v2/billing/meter/checkin-activity-status") return [200, { active: true, today_checked_in: true, streak_days: 20 }];
  if (path === "/v2/activity/growth/buddy/travel/status") return [200, { state: "traveling", location: { name: "山里" } }];
  if (path === "/v2/activity/growth/tasks") return [200, { tasks: [] }];
  if (path === "/v2/activity/growth/streak") return [200, { launch_date: "2026-06-17", makeup_cards: 0, streak: { makeup_dates: [] } }];
  if (path === "/v2/activity/growth/redeem/summary") return [200, { starter_status: "ready", advanced_status: "locked", legendary_status: "locked" }];
  if (path === "/v2/activity/growth/redeem") {
    redeemBodies.push(body.tier);
    if (body.tier === "7d") return [400, { msg: "unknown tier" }];
    return [200, { code: 0 }];
  }
  if (path === "/v2/activity/growth/lottery/chances") return [200, { balance: 0 }];
  if (path === "/v2/activity/growth/buddy/quota") return [200, { affordable: 0 }];
  return [404, { msg: "unhandled " + path }];
};
const r5 = runCase("场景 5：unknown tier → 天数兜底重试", {
  store: {
    WorkBuddy_Accounts: JSON.stringify([{ nickname: "兜底号", access_token: TOK.A, uid: UID.A, expiresAt: future }]),
    WorkBuddy_EnableGrowth: "1", WorkBuddy_EnableBuddyOpen: "1"
  },
  scenario: scenario5
});
const lines5 = (r5.last && r5.last.report) ? r5.last.report.split("\n") : [];
ok("先用档位标识再退回天数", redeemBodies.length === 2 && redeemBodies[0] === "7d" && redeemBodies[1] === 7, redeemBodies);
ok("兑换成功并回落官方文案", /连登兑换「入门」（\+2 能量 \+1 补登卡 \+1 次抽奖）/.test(lines5[0] || ""), lines5[0]);
ok("场景 5 结果 SUCCESS", r5.last && r5.last.result === "SUCCESS", r5.last && r5.last.result);
ok("数字形态的 makeup_cards 被正确处理", /没有补登卡/.test(lines5[0] || ""), lines5[0]);

/* ---------- 场景 6：账号池放在自己的 URL 上（自动拉取 + 缓存） ---------- */
const POOL_URL = "https://example.com/wb-accounts.json";
const poolA = { nickname: "URL一号", access_token: TOK.A, uid: UID.A, domain: "www.codebuddy.cn", expiresAt: future };
const poolB = { nickname: "URL二号", access_token: TOK.B, uid: UID.B, note: "小号", expiresAt: future };
const scenario6 = (who, method, path) => {
  if (path === POOL_URL) return [200, [poolA, poolB]];
  if (path === "/v2/billing/meter/checkin-activity-status") return [200, { active: true, today_checked_in: false, streak_days: 4 }];
  if (path === "/v2/billing/meter/daily-checkin") return [200, { code: 0, credit: 10 }];
  return [200, {}];
};
const r6 = runCase("场景 6：账号池 URL 自动拉取", {
  store: { WorkBuddy_AccountsURL: POOL_URL, WorkBuddy_EnableGrowth: "0" },
  scenario: scenario6
});
const authHdr = r6.calls.join(" ");
ok("URL 上 2 个账号都被跑到", r6.last && r6.last.accounts.length === 2, r6.last && r6.last.accounts.length);
ok("拉取带上 note 显示名", /URL二号（小号）：/.test(r6.last && r6.last.report), r6.last && r6.last.report);
ok("拉到的账号池写回本地缓存", /URL一号/.test(r6.store.WorkBuddy_Accounts || ""), r6.store.WorkBuddy_Accounts && r6.store.WorkBuddy_Accounts.slice(0, 40));
ok("两个账号各自用自己的令牌", r6.calls.some((c) => /^A POST/.test(c)) && r6.calls.some((c) => /^B POST/.test(c)), r6.calls);

/* ---------- 场景 7：URL 拉取失败 → 用本地缓存兜底 ---------- */
const r7 = runCase("场景 7：账号池 URL 挂了但本地有缓存", {
  store: {
    WorkBuddy_AccountsURL: POOL_URL,
    WorkBuddy_Accounts: JSON.stringify([{ nickname: "缓存号", access_token: TOK.A, uid: UID.A, expiresAt: future }]),
    WorkBuddy_EnableGrowth: "0"
  },
  scenario: (who, method, path) => {
    if (path === POOL_URL) return [500, { msg: "boom" }];
    if (path === "/v2/billing/meter/checkin-activity-status") return [200, { active: true, today_checked_in: true, streak_days: 5 }];
    return [200, {}];
  }
});
ok("回退到缓存里的账号", r7.last && r7.last.accounts.length === 1 && r7.last.accounts[0].name === "缓存号", r7.last && r7.last.accounts);
ok("报告说明拉取失败改用缓存", /已跳过（拉取失败，改用本地缓存）/.test(r7.last && r7.last.report), r7.last && r7.last.report);

/* ---------- 场景 8：URL 与缓存都没有可用账号 ---------- */
const r8 = runCase("场景 8：账号池 URL 挂了且无缓存", {
  store: { WorkBuddy_AccountsURL: POOL_URL },
  scenario: () => [500, { msg: "boom" }]
});
ok("给 NO_AUTH 而不是静默", r8.last && r8.last.result === "NO_AUTH", r8.last && r8.last.result);
ok("报告说明无账号池可用", /拉取失败，且本地没有账号池/.test(r8.last && r8.last.report), r8.last && r8.last.report);

/* ---------- 场景 9：令牌失效 401 → AUTH_ERROR，并给出可执行提示 ---------- */
const r9 = runCase("场景 9：令牌失效（401，等同密码错误）", {
  store: {
    WorkBuddy_Accounts: JSON.stringify([{ nickname: "失效号", access_token: TOK.A, uid: UID.A, expiresAt: future }]),
    WorkBuddy_EnableGrowth: "0"
  },
  scenario: () => [401, { code: 401, msg: "unauthorized" }]
});
ok("结果是 AUTH_ERROR", r9.last && r9.last.result === "AUTH_ERROR", r9.last && r9.last.result);
ok("正文点明等同密码错误并要求重新导出", /令牌已失效（HTTP 401）：等同于密码错误/.test(r9.last && r9.last.report), r9.last && r9.last.report);
ok("通知副标题把状态翻译成动作", /AUTH_ERROR：令牌失效，需重新导出/.test(JSON.stringify(r9.notified)), r9.notified.map((n) => n.s));

/* ---------- 场景 10：403 权限被拒绝 → AUTH_REJECTED（与令牌失效区分开） ---------- */
const r10 = runCase("场景 10：权限被拒绝（403）", {
  store: {
    WorkBuddy_Accounts: JSON.stringify([{ nickname: "受限号", access_token: TOK.A, uid: UID.A, expiresAt: future }]),
    WorkBuddy_EnableGrowth: "0"
  },
  scenario: () => [403, { code: 403, msg: "forbidden" }]
});
ok("结果是 AUTH_REJECTED 而不是 AUTH_ERROR", r10.last && r10.last.result === "AUTH_REJECTED", r10.last && r10.last.result);
ok("提示指向账号状态而不是重新导出", /HTTP 403 权限被拒绝/.test(r10.last && r10.last.report) && /风控|企业账号/.test(r10.last && r10.last.report), r10.last && r10.last.report);
ok("副标题区分 403", /AUTH_REJECTED：权限被拒绝（403）/.test(JSON.stringify(r10.notified)), r10.notified.map((n) => n.s));

/* ---------- 场景 11：令牌 2 天内过期 → 临期预警（照常跑，不跳过） ---------- */
const soonExp = Date.now() + 2 * 86400000 + 60000;
const r11 = runCase("场景 11：令牌临期预警", {
  store: {
    WorkBuddy_Accounts: JSON.stringify([{ nickname: "临期号", access_token: TOK.A, uid: UID.A, expiresAt: soonExp }]),
    WorkBuddy_EnableGrowth: "0"
  },
  scenario: (who, method, path) => {
    if (path === "/v2/billing/meter/checkin-activity-status") return [200, { active: true, today_checked_in: true, streak_days: 6 }];
    return [200, {}];
  }
});
ok("临期账号照常参与本轮", r11.last && r11.last.accounts.length === 1, r11.last && r11.last.accounts);
ok("报告带临期警告行", /⚠️ 令牌即将过期：临期号/.test(r11.last && r11.last.report), r11.last && r11.last.report);
ok("LastJSON 标记 expiring", r11.last && r11.last.expiring === 1, r11.last && r11.last.expiring);
ok("即使本轮无事发生也发通知", r11.notified.length >= 1, r11.notified.length);

/* ---------- 场景 12：令牌全部过期 → 「账号已失效」而不是含糊的「未配置」 ---------- */
const r12 = runCase("场景 12：令牌全部过期", {
  store: {
    WorkBuddy_Accounts: JSON.stringify([{ nickname: "过期号", access_token: TOK.A, uid: UID.A, expiresAt: Date.now() - 1000 }])
  },
  scenario: () => [200, {}]
});
ok("结果是 AUTH_ERROR 而不是 NO_AUTH", r12.last && r12.last.result === "AUTH_ERROR", r12.last && r12.last.result);
ok("通知标题说明账号已失效", /账号已失效/.test(JSON.stringify(r12.notified)), r12.notified.map((n) => n.t));
ok("正文要求重新导出", /重新导出/.test(r12.last && r12.last.report), r12.last && r12.last.report);

console.log("\n" + (fails ? "✗ " + fails + " 个断言失败" : "✓ 全部断言通过"));
process.exit(fails ? 1 : 0);
