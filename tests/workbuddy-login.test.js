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
  const sandbox = {
    console: { log: () => {} },
    $persistentStore: {
      read: (k) => (store[k] === undefined ? null : store[k]),
      write: (v, k) => { store[k] = String(v); }
    },
    $notify: (t, s, b) => notified.push({ t, s, b }),
    $done: () => {},
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
  return { store, notified, calls, last: store["WorkBuddy_LastJSON"] ? JSON.parse(store["WorkBuddy_LastJSON"]) : null };
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
  /自动续期失败/.test(r5.last.report) && /login\.html/.test(r5.last.report), r5.last.report);
ok("没有拿废令牌去打签到接口",
  !r5.calls.some((c) => c.url.indexOf("checkin-activity-status") >= 0), r5.calls.map((c) => c.url));

console.log(fails ? "\n✗ " + fails + " 个断言失败" : "\n✓ 全部断言通过");
process.exit(fails ? 1 : 0);
