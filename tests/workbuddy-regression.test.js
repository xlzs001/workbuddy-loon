/* WorkBuddy 缺陷回归测试（假令牌，不联网） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.resolve(__dirname, "..", "workbuddy.js"), "utf8");
let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS " + name);
  else { fails++; console.log("  FAIL " + name + (extra === undefined ? "" : " → " + JSON.stringify(extra))); }
}
function execute(opts) {
  const data = Object.assign({}, opts.store || {});
  const calls = [];
  const done = [];
  const storage = {
    read: (k) => data[k] === undefined ? null : data[k],
    write: (v, k) => { data[k] = String(v); return true; }
  };
  const prefs = {
    valueForKey: (k) => data[k] === undefined ? null : data[k],
    setValueForKey: (v, k) => { data[k] = String(v); return true; }
  };
  const sandbox = {
    console: { log() {} },
    $notify() {},
    $done: (arg) => done.push(arg),
    $argument: opts.argument,
    $request: opts.request,
    $httpClient: {
      get(opt, cb) { route("GET", opt, cb); },
      post(opt, cb) { route("POST", opt, cb); }
    }
  };
  if (opts.prefsOnly) sandbox.$prefs = prefs;
  else sandbox.$persistentStore = storage;
  function route(method, opt, cb) {
    calls.push({ method, url: opt.url, body: opt.body || "", headers: opt.headers || {} });
    const r = opts.route(method, opt.url, opt.body || "", opt.headers || {});
    cb(r.err || null, { status: r.status }, r.raw !== undefined ? r.raw : JSON.stringify(r.data || {}));
  }
  vm.runInContext(code, vm.createContext(sandbox));
  return { data, calls, done, last: data.WorkBuddy_LastJSON ? JSON.parse(data.WorkBuddy_LastJSON) : null };
}

console.log("\n=== save() 的 $prefs-only 兼容性 ===");
const prefsRun = execute({
  prefsOnly: true,
  store: { WorkBuddy_Token: "tok_0123456789abcdefghijklmnopqrstuvwxyz", WorkBuddy_Uid: "uid-1", WorkBuddy_EnableGrowth: "0", WorkBuddy_Notify: "0" },
  route(method, url) {
    if (/checkin-activity-status$/.test(url)) return { status: 200, data: { active: true, today_checked_in: true } };
    return { status: 200, data: {} };
  }
});
ok("仅有 $prefs 时仍保存 LastJSON", !!prefsRun.last, prefsRun.data);

console.log("\n=== daily-checkin 错误不能记成成功 ===");
function checkinFailure(status, body) {
  return execute({
    store: { WorkBuddy_Token: "tok_0123456789abcdefghijklmnopqrstuvwxyz", WorkBuddy_Uid: "uid-1", WorkBuddy_EnableGrowth: "0", WorkBuddy_Notify: "0" },
    route(method, url) {
      if (/checkin-activity-status$/.test(url)) return { status: 200, data: { active: true, today_checked_in: false } };
      if (/daily-checkin$/.test(url)) return { status, data: body };
      return { status: 200, data: {} };
    }
  });
}
const http500 = checkinFailure(500, { msg: "busy" });
ok("HTTP 500 结果为 ERROR", http500.last && http500.last.result === "ERROR", http500.last);
ok("HTTP 500 计入失败且不计成功", http500.last.accounts[0].failures === 1 && http500.last.accounts[0].ok === 0, http500.last.accounts[0]);
const bizFail = checkinFailure(200, { code: 123, msg: "业务失败" });
ok("HTTP 200 + 非零业务码结果为 ERROR", bizFail.last && bizFail.last.result === "ERROR", bizFail.last);

console.log("\n=== 账号池 URL 安全校验 ===");
const insecure = execute({
  store: { WorkBuddy_AccountsURL: "http://example.com/accounts.json", WorkBuddy_Notify: "0" },
  route() { throw new Error("HTTP 地址不应被请求"); }
});
ok("HTTP 账号池地址不会发起请求", insecure.calls.length === 0, insecure.calls);
ok("HTTP 账号池地址给出明确原因", /仅允许 HTTPS/.test(insecure.last && insecure.last.report), insecure.last);

const cached = JSON.stringify([{ nickname: "缓存号", access_token: "tok_0123456789abcdefghijklmnopqrstuvwxyz", uid: "uid-cache" }]);
const invalidRemote = execute({
  store: { WorkBuddy_AccountsURL: "https://example.com/accounts.json", WorkBuddy_Accounts: cached, WorkBuddy_EnableGrowth: "0", WorkBuddy_Notify: "0" },
  route(method, url) {
    if (url === "https://example.com/accounts.json") return { status: 200, raw: "{bad json" };
    if (/checkin-activity-status$/.test(url)) return { status: 200, data: { active: true, today_checked_in: true } };
    return { status: 200, data: {} };
  }
});
ok("非法远程内容不覆盖本地缓存", invalidRemote.data.WorkBuddy_Accounts === cached, invalidRemote.data.WorkBuddy_Accounts);
ok("非法远程内容回退到缓存账号", invalidRemote.last && invalidRemote.last.accounts[0].name === "缓存号", invalidRemote.last);

console.log("\n=== 接任务错误进入最终状态 ===");
const taskAccept500 = execute({
  store: {
    WorkBuddy_Token: "tok_0123456789abcdefghijklmnopqrstuvwxyz",
    WorkBuddy_Uid: "uid-1",
    WorkBuddy_EnableGrowth: "1",
    WorkBuddy_EnableBuddyOpen: "0",
    WorkBuddy_Notify: "0"
  },
  route(method, url) {
    if (/checkin-activity-status$/.test(url)) return { status: 200, data: { active: true, today_checked_in: true } };
    if (/buddy\/travel\/status$/.test(url)) return { status: 200, data: { state: "traveling" } };
    if (/growth\/tasks$/.test(url)) return { status: 200, data: { tasks: [{ task_code: "t1", accept_status: "not_accepted" }] } };
    if (/tasks\/accept$/.test(url)) return { status: 500, data: { msg: "busy" } };
    if (/growth\/streak$/.test(url)) return { status: 200, data: { makeup_cards: 0 } };
    if (/redeem\/summary$/.test(url)) return { status: 200, data: {} };
    if (/lottery\/chances$/.test(url)) return { status: 200, data: { balance: 0 } };
    return { status: 200, data: {} };
  }
});
ok("接任务 HTTP 500 使最终结果为 ERROR", taskAccept500.last && taskAccept500.last.result === "ERROR", taskAccept500.last);
ok("接任务 HTTP 500 出现在报告并计入失败", /接任务失败：busy/.test(taskAccept500.last.report) && taskAccept500.last.failures === 1, taskAccept500.last);

console.log("\n=== 登录回调来源与一次性事务 ===");
const badCallback = execute({
  argument: "login",
  request: { url: "https://evil.example/callback?state=x&code=y", method: "GET", headers: {} },
  route() { throw new Error("无效回调不应联网"); }
});
ok("非 CodeBuddy 回调被拒绝", badCallback.calls.length === 0 && /CodeBuddy%20HTTPS|回调地址/.test(JSON.stringify(badCallback.done)), badCallback.done);

const state = "state_abcdefghijklmnopqrstuvwxyz123456";
const verifier = "verifier_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const txStore = { WorkBuddy_LoginTransaction: JSON.stringify({ state, verifier, client: "account-console", createdAt: Date.now() }) };
const mismatch = execute({
  argument: "login",
  store: txStore,
  request: { url: "https://www.codebuddy.cn/auth/realms/copilot/account/?state=wrong&code=abc", method: "GET", headers: {} },
  route() { throw new Error("state 不匹配不应换令牌"); }
});
ok("state 不匹配时拒绝且不请求令牌", mismatch.calls.length === 0, mismatch.calls);
ok("无效事务会被清除", mismatch.data.WorkBuddy_LoginTransaction === "", mismatch.data.WorkBuddy_LoginTransaction);

const session = execute({
  argument: "login-session",
  request: { url: "https://www.codebuddy.cn/wb-login/session", method: "POST", headers: {}, body: JSON.stringify({ state, verifier, client: "account-console" }) },
  route() { throw new Error("建立事务不应联网"); }
});
ok("合法登录事务写入存储", JSON.parse(session.data.WorkBuddy_LoginTransaction).state === state, session.data);
ok("登录事务接口返回 204", session.done[0] && session.done[0].response.status === 204, session.done);

console.log("\n" + (fails ? "✗ " + fails + " 个断言失败" : "✓ 全部断言通过"));
process.exit(fails ? 1 : 0);
