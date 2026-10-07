/* WorkBuddy 手机登录 / 自动续期 mock 测试（假令牌，不联网）
 *
 * 覆盖：
 *   1. argument=login：Keycloak 回调 → 换令牌 → 验证可用 → 写入账号池
 *   2. 换令牌失败（invalid_grant）→ 不写账号池，通知说明原因
 *   3. 换到令牌但签到接口 401 → 仍写入，但通知明确「未验证通过」
 *   4. 账号池里过期但有 refresh_token → 跑之前自动续期，并用新令牌签到
 *   5. 续期失败 → 该账号报「自动续期失败」，整体状态 AUTH_ERROR（不是 NO_AUTH）
 *
 * 跑法：node tests/workbuddy-login.test.js
 */
const fs = require("fs");
const vm = require("vm");

const SRC = "/Users/cccc/Desktop/workbuddy-loon/workbuddy.js";
const code = fs.readFileSync(SRC, "utf8");
const KC_TOKEN = "https://www.codebuddy.cn/auth/realms/copilot/protocol/openid-connect/token";

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS " + name);
  else { fails++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}
function b64u(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function jwt(sub, nick, expSec) {
  return "eyJhbGciOiJub25lIn0." + b64u({ sub: sub, nickname: nick, preferred_username: nick, exp: expSec }) + ".sig";
}
const DAY = 86400000;

function runCase(name, opts) {
  console.log("\n=== " + name + " ===");
  const store = Object.assign({}, opts.store || {});
  const notified = [];
  const calls = [];
  const doneArgs = [];
  const sandbox = {
    console: { log: () => {} },
    $persistentStore: {
      read: (k) => (store[k] === undefined ? null : store[k]),
      write: (v, k) => { store[k] = String(v); }
    },
    $notify: (t, s, b) => notified.push({ t, s, b }),
    $done: (a) => { doneArgs.push(a); },
    $argument: opts.argument,
    $request: opts.request,
    $httpClient: {
      get: (opt, cb) => { const r = route("GET", opt.url, opt.body, opt.headers); cb(null, r, r.data === undefined ? null : JSON.stringify(r.data)); },
      post: (opt, cb) => { const r = route("POST", opt.url, opt.body, opt.headers); cb(null, r, r.data === undefined ? null : JSON.stringify(r.data)); }
    }
  };
  function route(method, url, body, headers) {
    calls.push({ method: method, url: url, body: body || "", auth: (headers && headers.Authorization) || "" });
    if (url.indexOf("/protocol/openid-connect/token") >= 0) return opts.token(method, body);
    return opts.api(method, url, body, headers);
  }
  vm.runInContext(code, vm.createContext(sandbox));
  return { store, notified, calls, doneArgs, last: store["WorkBuddy_LastJSON"] ? JSON.parse(store["WorkBuddy_LastJSON"]) : null };
}

const API_OK = () => ({ status: 200, data: { code: 0, active: true, today_checked_in: true, today_credit: 5, streak_days: 4 } });
const pool = (store) => JSON.parse(store["WorkBuddy_Accounts"] || "[]");
const q = (body) => String(body || "").split("&").reduce((a, kv) => {
  const i = kv.indexOf("="); if (i > 0) a[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); return a;
}, {});

/* ---------- 场景 1：登录换令牌成功 ---------- */
const AT1 = jwt("uid-phone-1", "手机号账号", Math.floor((Date.now() + 40 * DAY) / 1000));
const r1 = runCase("场景 1：argument=login 换令牌成功并写入账号池", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=xyz&session_state=aa&code=abc-123-code" },
  token: () => ({ status: 200, data: { access_token: AT1, refresh_token: "RT-1-0123456789", expires_in: 3600, token_type: "Bearer" } }),
  api: API_OK
});
const p1 = pool(r1.store);
const t1 = r1.calls.find((c) => c.url.indexOf("openid-connect/token") >= 0);
ok("向 Keycloak 令牌端点发了 authorization_code 请求",
  !!t1 && q(t1.body).grant_type === "authorization_code" && q(t1.body).code === "abc-123-code", t1 && t1.body);
ok("用了公开客户端 account-console 和注册过的 redirect_uri",
  q(t1.body).client_id === "account-console" &&
  q(t1.body).redirect_uri === "https://www.codebuddy.cn/auth/realms/copilot/account/", q(t1.body));
ok("账号池写入 1 条，uid/令牌/refresh_token/client 都对",
  p1.length === 1 && p1[0].uid === "uid-phone-1" && p1[0].access_token === AT1 &&
  p1[0].refresh_token === "RT-1-0123456789" && p1[0].client === "account-console", p1);
ok("过期时间取自 JWT exp（毫秒），不是 0", p1[0].expiresAt > Date.now() + 30 * DAY, p1[0].expiresAt);
ok("通知标题是登录成功", r1.notified.length === 1 && r1.notified[0].t === "WorkBuddy 登录成功", r1.notified);
ok("通知正文说明可用并提到以后能自动续期",
  /可用 ✓/.test(r1.notified[0].b) && /自动续期|自己续期/.test(r1.notified[0].b), r1.notified[0].b);
ok("没有把令牌写进通知（只写长度/昵称）", !/eyJhbGciOiJub25lIn0/.test(JSON.stringify(r1.notified)), "leak");
const d1 = r1.doneArgs.filter((a) => a && a.response).pop();
ok("回了一个 302 让浏览器跳回登录页（所以手机上一定能看到结果）",
  !!d1 && d1.response.status === 302, r1.doneArgs);
ok("跳回地址带 ok=1 和昵称",
  !!d1 && /wb-login\?ok=1&name=/.test(d1.response.headers.Location) &&
  d1.response.headers.Location.indexOf(encodeURIComponent("手机号账号")) > 0,
  d1 && d1.response.headers.Location);

/* ---------- 场景 2：换令牌失败 ---------- */
const r2 = runCase("场景 2：code 已失效（invalid_grant），不写账号池", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?code=used-code" },
  token: () => ({ status: 400, data: { error: "invalid_grant", error_description: "Code not valid" } }),
  api: API_OK
});
ok("没有写入账号池", !r2.store["WorkBuddy_Accounts"], r2.store["WorkBuddy_Accounts"]);
ok("通知标题是登录失败", r2.notified.length === 1 && r2.notified[0].t === "WorkBuddy 登录失败", r2.notified);
ok("正文带上服务端原因并提示重登",
  /Code not valid/.test(r2.notified[0].b) && /重新登/.test(r2.notified[0].b), r2.notified[0].b);
const d2 = r2.doneArgs.filter((a) => a && a.response).pop();
ok("失败也跳回登录页并把原因带在 err 里（用户能看到为什么）",
  !!d2 && d2.response.status === 302 && /wb-login\?err=/.test(d2.response.headers.Location) &&
  decodeURIComponent(d2.response.headers.Location).indexOf("Code not valid") > 0,
  d2 && d2.response.headers.Location);

/* ---------- 场景 3：令牌换到了但签到接口不认 ---------- */
const AT3 = jwt("uid-phone-9", "不认的账号", Math.floor((Date.now() + 40 * DAY) / 1000));
const r3 = runCase("场景 3：令牌换到但 copilot 回 401", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?code=fresh-code" },
  token: () => ({ status: 200, data: { access_token: AT3, refresh_token: "RT-3", token_type: "Bearer" } }),
  api: () => ({ status: 401, data: {} })
});
ok("仍然写入账号池（让用户自己决定去留）", pool(r3.store).length === 1, pool(r3.store));
ok("通知明确「未验证通过」", /未验证通过/.test(r3.notified[0].t), r3.notified[0].t);
const d3 = r3.doneArgs.filter((a) => a && a.response).pop();
ok("未验证通过也跳回登录页（warn 分支）",
  !!d3 && d3.response.status === 302 && /wb-login\?warn=1/.test(d3.response.headers.Location),
  d3 && d3.response.headers.Location);
ok("正文说明这个客户端签发的令牌可能不被接受",
  /签到接口回报 HTTP 401/.test(r3.notified[0].b) && /签发的令牌可能不被接受/.test(r3.notified[0].b), r3.notified[0].b);

/* ---------- 场景 4：过期账号自动续期后再签到 ---------- */
const AT2 = jwt("uid-phone-1", "手机号账号", Math.floor((Date.now() + 40 * DAY) / 1000));
let refreshCalls = 0;
const r4 = runCase("场景 4：refresh_token 自动续期", {
  store: {
    WorkBuddy_Accounts: JSON.stringify([{
      nickname: "手机号账号", access_token: jwt("uid-phone-1", "手机号账号", Math.floor((Date.now() - DAY) / 1000)),
      uid: "uid-phone-1", expiresAt: Date.now() - DAY, refresh_token: "RT-OLD", client: "account-console"
    }]),
    WorkBuddy_Budget: "120"
  },
  token: (m, body) => {
    if (q(body).grant_type !== "refresh_token") return { status: 400, data: { error: "unsupported_grant_type" } };
    refreshCalls++;
    return { status: 200, data: { access_token: AT2, refresh_token: "RT-NEW", expires_in: 3600, token_type: "Bearer" } };
  },
  api: API_OK
});
ok("确实发了一次 refresh_token 续期请求", refreshCalls === 1, refreshCalls);
ok("签到用的是续期后的新令牌", r4.calls.some((c) => c.auth === "Bearer " + AT2), r4.calls.map((c) => c.auth));
ok("账号池被回写：新 access_token + 新 refresh_token + 新过期时间",
  pool(r4.store)[0].access_token === AT2 && pool(r4.store)[0].refresh_token === "RT-NEW" &&
  pool(r4.store)[0].expiresAt > Date.now() + 30 * DAY, pool(r4.store)[0]);
ok("报告里有一行「已自动续期」", /已自动续期：手机号账号/.test(r4.last.report), r4.last.report);
ok("本轮结果正常（ALREADY），没有因为续期出问题",
  r4.last.result === "ALREADY", r4.last.result);

/* ---------- 场景 5：续期失败 ---------- */
const r5 = runCase("场景 5：续期失败（refresh_token 作废）", {
  store: {
    WorkBuddy_Accounts: JSON.stringify([{
      nickname: "失效号", access_token: jwt("uid-phone-2", "失效号", Math.floor((Date.now() - DAY) / 1000)),
      uid: "uid-phone-2", expiresAt: Date.now() - DAY, refresh_token: "RT-DEAD", client: "account-console"
    }])
  },
  token: () => ({ status: 400, data: { error: "invalid_grant", error_description: "Invalid refresh token. Token client and authorized client don't match" } }),
  api: API_OK
});
ok("结果是有意义的 AUTH_ERROR（不是含糊的 NO_AUTH）", r5.last.result === "AUTH_ERROR", r5.last.result);
ok("通知标题点明「账号已失效」", /账号已失效/.test(r5.notified[0].t), r5.notified[0].t);
ok("报告写明续期失败并给出登录页",
  /自动续期失败/.test(r5.last.report) && /wb-login/.test(r5.last.report), r5.last.report);
ok("没有拿废令牌去打签到接口",
  !r5.calls.some((c) => c.url.indexOf("checkin-activity-status") >= 0), r5.calls.map((c) => c.url));

/* ---------- 场景 6：带 ?error= 的失败回调（没有 code） ---------- */
/* 这条最关键：codebuddy 的网关对 /account/** 做了来源限制，非白名单 IP 直接回
   403 {"message":"Your IP address is not allowed"}。若这种失败回调漏给网关，手机上
   看到的就是那段 JSON。所以脚本必须自己拦住它，并跳回登录页说清原因。 */
const r6 = runCase("场景 6：回调带 error 而不是 code（例如 PKCE 参数不全）", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?error=invalid_request&error_description=Missing+parameter%3A+code_challenge_method&state=wb" },
  token: () => { throw new Error("不该去换令牌"); },
  api: () => { throw new Error("不该打签到接口"); }
});
ok("没有去请求令牌端点（没 code 就不换）",
  !r6.calls.some((c) => c.url.indexOf("openid-connect/token") >= 0), r6.calls.map((c) => c.url));
ok("通知说明原因（PKCE 参数不全）",
  r6.notified.length === 1 && /invalid_request/.test(r6.notified[0].s) &&
  /PKCE/.test(r6.notified[0].b), r6.notified);
const d6 = r6.doneArgs.filter((a) => a && a.response).pop();
ok("照样回 302 跳回登录页（而不是把请求放给 codebuddy 网关）",
  !!d6 && d6.response.status === 302 && /wb-login\?err=/.test(d6.response.headers.Location),
  d6 && d6.response.headers.Location);
ok("跳回时带的 msg 解释了原因",
  decodeURIComponent(d6.response.headers.Location).indexOf("PKCE") > 0,
  d6 && decodeURIComponent(d6.response.headers.Location));

/* ---------- 场景 7：error=access_denied（用户自己点了取消） ---------- */
const r7 = runCase("场景 7：用户取消授权（access_denied）", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?error=access_denied&state=wb" },
  token: () => { throw new Error("不该去换令牌"); },
  api: () => { throw new Error("不该打签到接口"); }
});
ok("文案告诉用户是自己取消了", /取消|拒绝/.test(r7.notified[0].b), r7.notified[0].b);
const d7 = r7.doneArgs.filter((a) => a && a.response).pop();
ok("仍然 302 回登录页", !!d7 && d7.response.status === 302, d7);

/* ---------- 场景 8：既没 code 也没 error（例如手滑访问了一条怪地址） ---------- */
const r8 = runCase("场景 8：回调地址里既没有 code 也没有 error", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/" },
  token: () => { throw new Error("不该去换令牌"); },
  api: () => { throw new Error("不该打签到接口"); }
});
ok("通知说明没抓到 code、也没放给网关", /没有 code/.test(r8.notified[0].b), r8.notified[0].b);
const d8 = r8.doneArgs.filter((a) => a && a.response).pop();
ok("回 302 回登录页", !!d8 && d8.response.status === 302 && /wb-login\?err=/.test(d8.response.headers.Location), d8);

/* ---------- 场景 9：PKCE verifier 编在回调 URL 的 state 里（登录页的做法） ---------- */
const AT9 = jwt("uid-pkce-9", "新登录账号", Math.floor((Date.now() + 40 * DAY) / 1000));
const r9 = runCase("场景 9：回调 state 里带 verifier → 自动当 code_verifier 用", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=ab12cd34~VERIFIER-9-xyz&session_state=aa&code=code-9" },
  token: (m, body) => (q(body).code_verifier === "VERIFIER-9-xyz"
    ? { status: 200, data: { access_token: AT9, refresh_token: "RT-9", expires_in: 3600 } }
    : { status: 400, data: { error: "invalid_grant", error_description: "Missing parameter: code_verifier" } }),
  api: API_OK
});
const t9 = r9.calls.find((c) => c.url.indexOf("openid-connect/token") >= 0);
ok("从 state 里取出 verifier 并发给令牌端点（服务端强制 PKCE 也能换到）",
  !!t9 && q(t9.body).code_verifier === "VERIFIER-9-xyz", t9 && t9.body);
ok("换到令牌并写入账号池", pool(r9.store).length === 1 && pool(r9.store)[0].uid === "uid-pkce-9", pool(r9.store));

/* ---------- 场景 10：BoxJS 手填的 verifier 优先级更高 ---------- */
const AT10 = jwt("uid-pkce-10", "手填优先", Math.floor((Date.now() + 40 * DAY) / 1000));
const r10 = runCase("场景 10：BoxJS 里手填的 WorkBuddy_LoginVerifier 优先于 state", {
  argument: "login",
  store: { WorkBuddy_LoginVerifier: "HAND-TYPED-10" },
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=ab12cd34~FROM-STATE&code=code-10" },
  token: (m, body) => (q(body).code_verifier === "HAND-TYPED-10"
    ? { status: 200, data: { access_token: AT10, expires_in: 3600 } }
    : { status: 400, data: { error: "invalid_grant" } }),
  api: API_OK
});
const t10 = r10.calls.find((c) => c.url.indexOf("openid-connect/token") >= 0);
ok("手填值覆盖 state 里的值", !!t10 && q(t10.body).code_verifier === "HAND-TYPED-10", t10 && t10.body);
ok("照样登录成功", r10.notified.length === 1 && r10.notified[0].t === "WorkBuddy 登录成功", r10.notified);

/* ---------- 场景 11：两边都没有 verifier → 明确让用户重新点一次登录 ---------- */
const r11 = runCase("场景 11：没有 PKCE verifier（旧式手搓链接）", {
  argument: "login",
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=nostate&code=code-11" },
  token: () => ({ status: 400, data: { error: "invalid_grant", error_description: "Missing parameter: code_verifier" } }),
  api: () => { throw new Error("不该打签到接口"); }
});
ok("通知里明确要求回登录页重新点一次（而不是让用户去填 BoxJS）",
  /PKCE verifier/.test(r11.notified[0].b) && /重新点一次/.test(r11.notified[0].b), r11.notified[0].b);
ok("没有把没验证的令牌写进账号池", pool(r11.store).length === 0, pool(r11.store));

/* ---------- 场景 12：BoxJS 交棒（不需要 MITM）：粘来的回调地址 → 自动换令牌 ---------- */
const AT12 = jwt("uid-pickup-12", "手机号账号B", Math.floor((Date.now() + 40 * DAY) / 1000));
const r12 = runCase("场景 12：BoxJS「登录回调地址」交棒，cron/手动跑时先换令牌", {
  // 注意：这里没有 argument（＝定时任务或手动运行那种空参调用），也没有 $request
  store: { WorkBuddy_LoginCallback: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=ab12cd34~VERIFIER-12&session_state=aa&code=code-12" },
  token: (m, body) => (q(body).code_verifier === "VERIFIER-12" && q(body).code === "code-12"
    ? { status: 200, data: { access_token: AT12, refresh_token: "RT-12", expires_in: 3600 } }
    : { status: 400, data: { error: "invalid_grant" } }),
  api: API_OK
});
const t12 = r12.calls.find((c) => c.url.indexOf("openid-connect/token") >= 0);
ok("没有 $request 也能换令牌（走的正是脚本自己发请求这条路）",
  !!t12 && q(t12.body).code === "code-12" && q(t12.body).code_verifier === "VERIFIER-12", t12 && t12.body);
ok("令牌写入账号池", pool(r12.store).length === 1 && pool(r12.store)[0].uid === "uid-pickup-12", pool(r12.store));
ok("换了令牌就不再顺便跑签到（本轮只做登录，避免半路 $done 打断）",
  r12.calls.filter((c) => c.url.indexOf("copilot.tencent.com") >= 0).length === 1,
  r12.calls.map((c) => c.url));
ok("回调地址字段被清空（不会每一轮都拿它重试）", r12.store["WorkBuddy_LoginCallback"] === "", r12.store["WorkBuddy_LoginCallback"]);
ok("通知里告诉用户再点一次就能签到", /再点一次/.test(r12.notified[0].b), r12.notified[0].b);

/* ---------- 场景 13：交棒进来的 code 过期/无效 → 清空字段并说清楚 ---------- */
const r13 = runCase("场景 13：交棒的回调地址换不了令牌（code 过期）", {
  store: { WorkBuddy_LoginCallback: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=ab~VER-13&code=expired-13" },
  token: () => ({ status: 400, data: { error: "invalid_grant", error_description: "Code not valid" } }),
  api: () => { throw new Error("不该打签到接口"); }
});
ok("没有写入账号池", pool(r13.store).length === 0, pool(r13.store));
ok("回调地址字段被清空 + 通知里说明原因",
  r13.store["WorkBuddy_LoginCallback"] === "" && r13.notified[0].s === "换令牌失败" && /已清掉/.test(r13.notified[0].b),
  r13.notified[0].s + " / " + r13.notified[0].b);
ok("没有去碰签到接口", r13.calls.every((c) => c.url.indexOf("copilot.tencent.com") < 0), r13.calls.map((c) => c.url));

/* ---------- 场景 14：那个字段里不是网址 → 忽略它，本轮照常（保护定时任务） ---------- */
const r14 = runCase("场景 14：「登录回调地址」是垃圾值时不影响正常流程", {
  argument: "login",
  store: { WorkBuddy_LoginCallback: "随手打的字" },
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=ab~VER-14&code=code-14" },
  token: () => ({ status: 200, data: { access_token: jwt("uid-14", "账号14", Math.floor((Date.now() + 40 * DAY) / 1000)), expires_in: 3600 } }),
  api: API_OK
});
ok("垃圾值没有被当成待换取的地址（仍然按 $request 里的回调走）",
  r14.calls.some((c) => c.url.indexOf("openid-connect/token") >= 0), r14.calls.map((c) => c.url));
ok("垃圾值也没有被误清空", r14.store["WorkBuddy_LoginCallback"] !== undefined, r14.store["WorkBuddy_LoginCallback"]);

console.log(fails ? "\n✗ " + fails + " 个断言失败" : "\n✓ 全部断言通过");
process.exit(fails ? 1 : 0);
