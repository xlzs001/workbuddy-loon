/*******************************************
 * WorkBuddy 自动签到 · Loon / Surge / QuantumultX / BoxJS
 *
 * 由 88lin/workbuddy-auto-signin 的 signin.py 移植：
 *   签到      → /v2/billing/meter/checkin-activity-status + /daily-checkin
 *   成长中心  → /v2/activity/growth/**（旅行礼物、派 Buddy、任务、补登、
 *               连登兑换、盲盒、Buddy 能量盲盒）
 *
 * 五种被调用方式（同一份脚本）：
 *   1. cron        → 自动签到 / 成长中心轮询
 *   2. http-request → 抓取手机端请求里的 Authorization 自动保鲜令牌
 *   3. panel       → 读取上次结果做卡片展示
 *   4. argument=login → 接管手机登录的 Keycloak 回调，把换到的令牌写进账号池
 *                        （并顺手验证令牌能不能签到，能续期的一并记住 refresh_token）
 *   5. argument=page  → 直接吐出手机登录页的 HTML（页面挂在 codebuddy 域名下，
 *                        走插件自己的 MITM，不依赖 GitHub Pages；见 PAGE_URL）
 *******************************************/

var HOST = "https://copilot.tencent.com";
var GROWTH = HOST + "/v2/activity/growth";

/* 手机登录：codebuddy 自己的 Keycloak（realm copilot）。
 *   auth  = https://www.codebuddy.cn/auth/realms/copilot/protocol/openid-connect/auth
 *   token = .../protocol/openid-connect/token（CORS 全开放，浏览器里也能直接换）
 * account-console / account 是这里仅有的公开客户端（不需要 client_secret），
 * 电脑版用的 console 是机密客户端，所以我们自己续不了它的令牌，只能重登。 */
/* 登录页有两种来源，默认用第一种 —— 它不依赖 GitHub Pages（github.io 在部分网络下不通）：
 *   1. PAGE_URL      → https://www.codebuddy.cn/wb-login
 *                      本脚本 argument=page 直接输出的 HTML，由插件的「WorkBuddy登录页」规则触发
 *   2. LOGIN_URL_ALT → GitHub Pages 上的同一份 login.html（备用手动路径） */
var PAGE_URL = "https://www.codebuddy.cn/wb-login";
var LOGIN_URL = PAGE_URL;
var LOGIN_URL_ALT = "https://xlzs001.github.io/workbuddy-loon/login.html";
var KC = "https://www.codebuddy.cn/auth/realms/copilot";
var KC_TOKEN = KC + "/protocol/openid-connect/token";
var KC_REDIRECT = KC + "/account/";
var KC_SCOPE = "openid profile offline_access email";
var RENEWED = [];          // 本轮自动续期成功的账号名
var MAKEUP_MAX = 1;        // 每轮最多消耗几张补登卡（与 signin.py 对齐）
var GLOBAL_BUDGET = 540;   // 整轮总预算（秒），必须小于插件 cron 的 timeout
var BUDGET = 240;          // 当前账号可用预算，按账号数摊分
var T0 = Date.now();       // 当前账号的计时起点
var RUN_T0 = Date.now();   // 整轮计时起点（多账号时整轮共享 GLOBAL_BUDGET）

var parts = [];
var warnings = [];
var ctx = { ok: 0, fail: 0, hard: 0, credits: 0, result: "", ended: false, done: null };

/* 多账号：账号池取自 BoxJS 的 WorkBuddy_Accounts，
 * 可以直接把切号工具导出的 JSON（含 access_token / uid / nickname）整段粘进去。 */
var ACC = { name: "默认账号", token: "", uid: "", enterpriseId: "", domain: "" };
var ACCOUNTS = [];   // 本轮要跑的账号
var SKIPPED = [];    // 被跳过的账号及原因
var RESULTS = [];    // 每个账号的结果
var accIndex = 0;
var FINALIZED = false;

/* ---------------- 存储 / 参数 ---------------- */

function store(key, def) {
  var v = null;
  try { if (typeof $persistentStore !== "undefined" && $persistentStore) v = $persistentStore.read(key); } catch (e) {}
  if (v === null || v === undefined || v === "") {
    try { if (typeof $prefs !== "undefined" && $prefs && $prefs.valueForKey) v = $prefs.valueForKey(key); } catch (e) {}
  }
  if (v === null || v === undefined || v === "") return def === undefined ? "" : def;
  return String(v);
}

function save(key, value) {
  var text = String(value);
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore) {
      if ($persistentStore.write(text, key) !== false) return true;
    }
  } catch (e) {}
  try {
    if (typeof $prefs !== "undefined" && $prefs && $prefs.setValueForKey) {
      return $prefs.setValueForKey(text, key) !== false;
    }
  } catch (e) {}
  return false;
}

function argument() {
  try { if (typeof $argument !== "undefined" && $argument) return String($argument); } catch (e) {}
  return store("WorkBuddy_Mode", "");
}

function flag(key, def) {
  var v = store(key, def).toLowerCase();
  return (v === "1" || v === "true" || v === "yes" || v === "on");
}

function runLeft() { return GLOBAL_BUDGET - (Date.now() - RUN_T0) / 1000; }

function left() { return Math.min(BUDGET - (Date.now() - T0) / 1000, runLeft()); }

function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/* ---------------- 通用工具 ---------------- */

function dig(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  var v = obj[key];
  return (v === undefined) ? null : v;
}

function asInt(v, def) {
  var n = parseInt(v, 10);
  return isNaN(n) ? (def === undefined ? 0 : def) : n;
}

function clientToken() {
  var hex = "0123456789abcdef";
  var s = "";
  for (var i = 0; i < 32; i++) s += hex.charAt(Math.floor(Math.random() * 16));
  if (s.charAt(12) !== "x") { /* 仅保持 uuid 形状，服务端只做幂等去重 */ }
  return "u-" + s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20);
}

function now() {
  var d = new Date();
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
         p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function today() {
  var d = new Date();
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function notify(title, subtitle, body) {
  if (!flag("WorkBuddy_Notify", "1")) return;
  try { if (typeof $notify !== "undefined") $notify(title, subtitle || "", body || ""); } catch (e) {}
}

/* 脚本日志：Loon / Surge 的「脚本日志」里能直接看到，排错全靠它（绝不打印令牌本体） */
function log() {
  try {
    if (typeof console !== "undefined" && console.log) console.log.apply(console, Array.prototype.slice.call(arguments));
  } catch (e) {}
}

function headers() {
  var h = {
    "Accept": "application/json",
    "Authorization": "Bearer " + (ACC.token || store("WorkBuddy_Token")),
    "Content-Type": "application/json",
    "User-Agent": "WorkBuddy"
  };
  var uid = ACC.uid || store("WorkBuddy_Uid");
  if (uid) h["X-User-Id"] = uid;
  var ent = ACC.enterpriseId || store("WorkBuddy_EnterpriseId");
  if (ent) { h["X-Enterprise-Id"] = ent; h["X-Tenant-Id"] = ent; }
  var dom = ACC.domain || store("WorkBuddy_Domain");
  if (dom) h["X-Domain"] = dom;
  return h;
}

function api(method, path, body, cb) {
  var url = path.indexOf("http") === 0 ? path : (HOST + path);
  var opt = { url: url, headers: headers() };
  var fn = (method === "POST") ? $httpClient.post : $httpClient.get;
  if (method === "POST") opt.body = JSON.stringify(body || {});
  fn(opt, function (err, resp, data) {
    if (err) return cb(-1, { error: String(err) });
    var code = 0;
    try {
      code = (resp && (resp.status || resp.statusCode)) || 0;
      code = asInt(code, 0);
    } catch (e) {}
    var json = null;
    try { json = JSON.parse(data); } catch (e) {}
    var out = json === null ? { raw: String(data == null ? "" : data).slice(0, 300) } : json;
    if (code >= 200 && code < 300) {
      log("· " + method + " " + path + " → " + code);
    } else {
      log("× " + method + " " + path + " → " + code + "  " + trunc(out.error || out.msg || out.raw || "", 140));
    }
    cb(code, out);
  });
}

function post(url, body, cb) { api("POST", url, body, cb); }
function get(url, cb) { api("GET", url, null, cb); }

/* 拉取第三方 URL 时**不带任何认证头**，避免把 WorkBuddy 令牌泄露给托管方 */
function fetchPlain(url, cb) {
  $httpClient.get({ url: url, headers: { "Accept": "application/json" } }, function (err, resp, data) {
    if (err) return cb(-1, String(err), "");
    var code = 0, finalUrl = "";
    try {
      code = asInt((resp && (resp.status || resp.statusCode)) || 0, 0);
      finalUrl = String((resp && (resp.url || resp.finalUrl)) || url);
    } catch (e) {}
    cb(code, String(data === null || data === undefined ? "" : data), finalUrl);
  });
}

function isAuth(code) { return code === 401 || code === 403; }

function isHard(code) { return code === -1 || code >= 500; }

function httpLabel(code) {
  if (code === -1) return "网络不可达";
  if (code === 0) return "无响应";
  return "HTTP " + code;
}

function note(code, body, label, required) {
  if (code >= 200 && code < 300 && (!required || asInt(dig(body, "code"), 0) === 0)) return false;
  var detail = "";
  if (body && typeof body === "object") detail = String(dig(body, "error") || dig(body, "msg") || "");
  parts.push(label + "失败：" + (detail || httpLabel(code)));
  if (required || isHard(code)) { ctx.fail++; ctx.hard++; }
  return true;
}

/* ---------------- 结束 / 输出 ---------------- */

var ERROR_STATES = { "NETWORK": 1, "AUTH_ERROR": 1, "ERROR": 1, "NO_AUTH": 1, "TIMEOUT": 1, "AUTH_REJECTED": 1 };

/* 通知副标题里把状态翻译成人话，一眼知道该干什么 */
var STATUS_HINT = {
  "AUTH_ERROR": "令牌失效，去手机登录页重登",
  "AUTH_REJECTED": "权限被拒绝（403）",
  "NO_AUTH": "没读到账号，检查账号池",
  "NETWORK": "网络不可达",
  "TIMEOUT": "执行超时",
  "ERROR": "服务端错误"
};

function finish(result, report) {
  if (ctx.ended) return;
  ctx.ended = true;
  var r = result || ctx.result || "OK";
  // 硬错误状态优先；否则这一轮只要真领到过东西就算 SUCCESS，
  // 免得「非签到季 + 成长中心领了一堆」被记成 INACTIVE。
  if (!ERROR_STATES[r] && ctx.ok > 0) r = "SUCCESS";
  ctx.result = r;
  ctx.text = report || parts.join("；") || "无操作";
  // 单账号时 done === endAccount 之外的兜底：直接进入汇总
  if (typeof ctx.done === "function") return ctx.done();
  return finalize();
}

/* 认证类失败分两种，处理方式完全不同：
 *   401 → 令牌失效（WorkBuddy 没有密码，凭据就是 access_token，等价于「密码错误」）
 *   403 → 令牌本身有效但被服务端拒绝：未开通 / 被风控 / 企业账号权限不足 */
function authFail(code) {
  if (code === 403) {
    parts.push("权限被拒绝（HTTP 403）—— 令牌有效但服务端不接受，可能未开通、被风控或企业账号权限不足");
    return finish("AUTH_REJECTED", "HTTP 403 权限被拒绝：令牌能用但被服务端拦了，请确认账号状态（风控 / 企业账号）后重试");
  }
  parts.push("令牌已失效（HTTP " + code + "）—— 等同于密码错误，需要重新登录：" + LOGIN_URL);
  finish("AUTH_ERROR", "令牌已失效（HTTP " + code + "）：去手机登录页重新登录 " + LOGIN_URL + "（或在电脑上重新导出令牌）");
}

/* ---------------- 步骤 1：签到 ---------------- */

function stepCheckin(next) {
  post("/v2/billing/meter/checkin-activity-status", null, function (code, body) {
    if (code === -1) { ctx.result = "NETWORK"; return finish("NETWORK", "网络不可达，签到跳过，下次自动重试"); }
    if (isAuth(code)) return authFail(code);
    if (!(code >= 200 && code < 300)) return finish("ERROR", "签到接口返回异常（" + httpLabel(code) + "）");

    if (dig(body, "active") === false) {
      parts.push("签到活动未开启" + (dig(body, "activity_name") ? "（" + dig(body, "activity_name") + "）" : ""));
      ctx.result = "INACTIVE";
      return next();
    }
    if (dig(body, "today_checked_in") === true || dig(body, "today_checked_in") === 1) {
      return alreadyReport(body, "今日已签过", next);
    }

    post("/v2/billing/meter/daily-checkin", null, function (c2, b2) {
      if (c2 === -1) { ctx.result = "NETWORK"; return finish("NETWORK", "领取请求未能送达，下次自动重试"); }
      if (isAuth(c2)) return authFail(c2);
      var msg = String(dig(b2, "msg") || "");
      if (asInt(dig(b2, "code"), 0) === 10001 || msg.indexOf("已签") >= 0) {
        return alreadyReport(b2, "今日已签过（服务端判定已领取）", next);
      }
      if (!(c2 >= 200 && c2 < 300)) {
        parts.push("签到领取失败：" + (msg || httpLabel(c2)));
        ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0;
        return finish("ERROR");
      }
      var bizCode = dig(b2, "code");
      if (bizCode !== null && asInt(bizCode, -1) !== 0) {
        parts.push("签到领取失败：" + (msg || ("业务码 " + bizCode)));
        ctx.fail++; ctx.hard++;
        return finish("ERROR");
      }
      if (!b2 || typeof b2 !== "object") {
        parts.push("签到领取失败：服务端响应格式异常");
        ctx.fail++; ctx.hard++;
        return finish("ERROR");
      }
      var credit = dig(b2, "credit");
      ctx.ok++;
      ctx.result = "SUCCESS";
      if (credit !== null) {
        ctx.credits += asInt(credit);
        post("/v2/billing/meter/checkin-activity-status", null, function (c3, b3) {
          var fresh = (c3 >= 200 && c3 < 300) ? b3 : body;
          var tail = [];
          if (dig(fresh, "streak_days") !== null) tail.push("连续 " + dig(fresh, "streak_days") + " 天");
          if (dig(fresh, "total_credits") !== null) tail.push("累计 " + dig(fresh, "total_credits") + " 积分");
          parts.push("成功领取 " + asInt(credit) + " 积分" + (tail.length ? "（" + tail.join("，") + "）" : ""));
          next();
        });
      } else {
        parts.push("签到请求已提交（服务端未返回积分值）");
        next();
      }
    });
  });
}

function alreadyReport(body, prefix, next) {
  var inner = [];
  if (dig(body, "today_credit") !== null) inner.push("今日 +" + dig(body, "today_credit"));
  else if (dig(body, "daily_credit") !== null) inner.push("今日 +" + dig(body, "daily_credit"));
  if (dig(body, "streak_days") !== null) inner.push("连续 " + dig(body, "streak_days") + " 天");
  if (dig(body, "total_credits") !== null) inner.push("累计 " + dig(body, "total_credits") + " 积分");
  ctx.result = "ALREADY";
  parts.push(inner.length ? prefix + "（" + inner.join("，") + "）" : prefix);
  next();
}

/* ---------------- 步骤 2：成长中心 ---------------- */

function stepTravel(next) {
  get(GROWTH + "/buddy/travel/status", function (code, body) {
    if (isAuth(code)) return authFail(code);
    if (code === -1) { parts.push("旅行状态查询失败：网络不可达"); ctx.fail++; ctx.hard++; return next(); }
    note(code, body, "查旅行状态", false);
    var state = (code >= 200 && code < 300) ? dig(body, "state") : null;
    var limitReached = (code >= 200 && code < 300) && dig(body, "daily_limit_reached") === true;

    if (state === "traveling") {
      var loc = dig(body, "location");
      parts.push("Buddy 旅行中（" + ((loc && loc.name) || "?") + "）");
      return next();
    }
    if (state !== "arrived") {
      if (state === "idle" && limitReached) { parts.push("今日旅行名额已用完"); return next(); }
      if (state === "idle") return depart(next);
      return next();
    }

    post(GROWTH + "/buddy/travel/claim", { record_id: dig(body, "record_id") }, function (c2, b2) {
      if (isAuth(c2)) return authFail(c2);
      if (c2 >= 200 && c2 < 300 && dig(b2, "reward_credit") !== null) {
        var got = asInt(dig(b2, "reward_credit"));
        ctx.credits += got;
        ctx.ok++;
        parts.push("领旅行礼物 +" + got + " 积分");
        if (limitReached) { parts.push("今日旅行名额已用完"); return next(); }
        return depart(next);
      }
      parts.push("领旅行礼物失败：" + String(dig(b2, "msg") || httpLabel(c2)));
      ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0;
      next();
    });
  });

  function depart(cb) {
    get(GROWTH + "/buddy/travel/config", function (code, body) {
      if (isAuth(code)) return authFail(code);
      var locs = (code >= 200 && code < 300) ? dig(body, "locations") : null;
      if (!locs || !locs.length || !locs[0]) { parts.push("派 Buddy 跳过：没有可选地点"); return cb(); }
      post(GROWTH + "/buddy/travel/depart", { location_id: locs[0].id }, function (c2, b2) {
        if (isAuth(c2)) return authFail(c2);
        if (c2 >= 200 && c2 < 300) {
          var l = dig(b2, "location") || {};
          ctx.ok++;
          parts.push("派 Buddy 去" + (l.name || "?") + "（" + (dig(b2, "duration_hours") || l.duration_hours || "?") + " 小时后回）");
        } else {
          parts.push("派 Buddy 失败：" + String(dig(b2, "msg") || httpLabel(c2)));
          ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0;
        }
        cb();
      });
    });
  }
}

function stepTasks(next) {
  get(GROWTH + "/tasks", function (code, body) {
    if (isAuth(code)) return authFail(code);
    if (note(code, body, "查任务列表", false)) return next();
    var tasks = dig(body, "tasks");
    if (!tasks || !tasks.length) { parts.push("暂无新任务"); return next(); }

    var pending = [];
    var completable = [];
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i] || {};
      if (t.locked) continue;
      if (t.accept_status === "not_accepted" && t.task_code) pending.push(t.task_code);
      if (t.accept_status === "completed" && t.task_code) completable.push(t);
    }

    var i2 = 0;   // 接单批次游标
    var i3 = 0;   // 领奖游标

    function claimLoop() {
      if (i3 >= completable.length || left() <= 0) return next();
      var t = completable[i3++];
      post(GROWTH + "/tasks/" + t.task_code + "/claim", {}, function (c2, b2) {
        if (isAuth(c2)) return authFail(c2);
        if (c2 >= 200 && c2 < 300 && !dig(b2, "already_claimed")) {
          var rc = dig(b2, "credit") !== null ? asInt(dig(b2, "credit")) : asInt(t.reward_credit);
          var re = dig(b2, "energy") !== null ? asInt(dig(b2, "energy")) : asInt(t.reward_energy);
          ctx.credits += rc;
          ctx.ok++;
          parts.push("领任务奖「" + (t.title || t.task_code) + "」+credits" + rc + " +energy" + re);
        } else if (c2 >= 200 && c2 < 300) {
          parts.push("任务奖「" + (t.title || t.task_code) + "」已领取");
        } else {
          parts.push("领任务奖「" + (t.title || t.task_code) + "」失败：" + String(dig(b2, "msg") || httpLabel(c2)));
          ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0;
        }
        claimLoop();
      });
    }

    function acceptLoop() {
      if (i2 >= pending.length || left() <= 0) return claimLoop();
      var batch = pending.slice(i2, i2 + 20);
      i2 += 20;
      post(GROWTH + "/tasks/accept", { task_codes: batch }, function (c2, b2) {
        if (isAuth(c2)) return authFail(c2);
        if (!(c2 >= 200 && c2 < 300)) {
          parts.push("接任务失败：" + String(dig(b2, "msg") || dig(b2, "error") || httpLabel(c2)));
          ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0; ctx.result = "ERROR";
          return acceptLoop();
        }
        var res = dig(b2, "results");
        if (!Array.isArray(res)) {
          parts.push("接任务失败：服务端响应格式异常");
          ctx.fail++; ctx.hard++; ctx.result = "ERROR";
          return acceptLoop();
        }
        var accepted = 0;
        for (var k = 0; k < res.length; k++) {
          if (res[k] && res[k].status === "error") {
            parts.push("接单失败（" + (res[k].task_code || "?") + "：" + (res[k].message || "") + "）");
            ctx.fail++;
          } else if (res[k]) accepted++;
        }
        if (accepted > 0) ctx.ok++;
        acceptLoop();
      });
    }

    acceptLoop();
  });
}

function stepMakeup(next) {
  if (left() <= 0) { parts.push("时间预算耗尽，补登跳过"); return next(); }
  get(GROWTH + "/streak", function (code, body) {
    if (isAuth(code)) return authFail(code);
    if (note(code, body, "查连登状态", true)) { ctx.streak = null; return next(); }
    ctx.streak = body;

    var cardsObj = dig(body, "makeup_cards");
    var cards = (cardsObj && typeof cardsObj === "object") ? asInt(dig(cardsObj, "balance")) : asInt(cardsObj);
    if (cards <= 0) { parts.push("没有补登卡"); return next(); }

    get(GROWTH + "/heatmap", function (hc, hb) {
      if (isAuth(hc)) return authFail(hc);
      if (note(hc, hb, "查补登日历", true)) return next();

      var dates;
      try { dates = makeupCandidates(body, hb); }
      catch (e) { parts.push("补登日历异常（" + e + "），本轮不补登"); ctx.fail++; ctx.hard++; return next(); }
      if (!dates.length) { parts.push("没有需要补登的日期"); return next(); }

      var target = dates[0];
      post(GROWTH + "/makeup-cards/use", { target_date: target }, function (uc, ub) {
        if (isAuth(uc)) return authFail(uc);
        var ok = (uc >= 200 && uc < 300) && (asInt(dig(ub, "code"), 0) === 0);
        if (ok) {
          var l = dig(ub, "makeup_cards");
          var leftCards = (l && typeof l === "object") ? asInt(dig(l, "balance"), cards - 1) : asInt(l, cards - 1);
          ctx.ok++;
          ctx.streak = null;   // 补登会改变连签天数，后续必须重新取
          parts.push("补登 " + target + "（剩 " + leftCards + " 张卡）");
        } else {
          var msg = String(dig(ub, "msg") || "");
          if (uc === 400 && msg.toLowerCase() === "date is not broken, no makeup needed") {
            parts.push(target + " 已活跃或已补登，无需再次补登");
          } else {
            parts.push("补登 " + target + " 失败：" + (msg || httpLabel(uc)));
            ctx.fail++; ctx.hard++;
          }
        }
        next();
      });
    });
  });
}

function makeupCandidates(streakBody, heatmapBody) {
  var todayObj = dig(heatmapBody, "today");
  if (!todayObj || typeof todayObj !== "object") throw "缺少服务端日期";
  var day = String(todayObj.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw "服务端日期格式无效";
  var todayDate = day;

  var launch = String(dig(streakBody, "launch_date") || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(launch)) throw "缺少活动上线日期";
  var monthStart = todayDate.slice(0, 8) + "01";
  var floor = "2026-06-17";
  var start = monthStart > launch ? monthStart : launch;
  if (floor > start) start = floor;

  var streak = dig(streakBody, "streak");
  if (!streak || typeof streak !== "object") throw "连登状态格式无效";
  var madeUp = dig(streak, "makeup_dates");
  if (!madeUp || typeof madeUp.length !== "number") throw "已补登记录格式无效";
  var done = {};
  for (var i = 0; i < madeUp.length; i++) done[String(madeUp[i])] = true;

  var cells = dig(heatmapBody, "cells");
  if (!cells || typeof cells.length !== "number") throw "活跃日历缺少日期列表";
  var scores = {};
  for (var j = 0; j < cells.length; j++) {
    var c = cells[j];
    if (!c || typeof c !== "object") throw "活跃日历记录格式无效";
    var d = String(c.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw "活跃日历日期格式无效";
    var s = c.score;
    if (typeof s !== "number" || !isFinite(s) || s < 0) throw "活跃日历分数无效";
    if (scores[d] !== undefined && scores[d] !== s) throw "活跃日历同一日期记录冲突";
    scores[d] = s;
  }

  var out = [];
  for (var k in scores) {
    if (!scores.hasOwnProperty(k)) continue;
    if (scores[k] === 0 && k >= start && k < todayDate && !done[k]) out.push(k);
  }
  out.sort();
  out.reverse();   // 最近的断点优先
  return out;
}

/* 连登兑换：奖励描述优先用服务端实发的 *_granted 字段，
 * 挖不到才回落到官方文案（与 signin.py 的 _redeem_reward_desc 一致）。 */
var REDEEM_REWARDS = {
  "7d": "+2 能量 +1 补登卡 +1 次抽奖",
  "14d": "+50 积分 +3 能量 +1 补登卡 +1 次抽奖",
  "28d": "+150 积分 +5 能量 +1 补登卡 +1 次抽奖"
};

function redeemRewardDesc(b, tier) {
  var bits = [];
  var credit = asInt(dig(b, "credit_granted"), 0);
  var energy = asInt(dig(b, "energy_granted"), 0);
  var cards = asInt(dig(b, "cards_granted"), 0);
  var chances = asInt(dig(b, "chances_granted"), 0);
  if (credit) bits.push("+" + credit + " 积分");
  if (energy) bits.push("+" + energy + " 能量");
  if (cards) bits.push("+" + cards + " 补登卡");
  if (chances) bits.push("+" + chances + " 次抽奖");
  if (bits.length) return "（" + bits.join(" ") + "）";
  return "（" + (REDEEM_REWARDS[tier] || "奖励已到账") + "）";
}

/* 档位标识被判为「不认识」→ 退回落天数再试一次。
 * 这类 400 发生在参数校验阶段，服务端没兑换任何东西，重试不会重复领取；
 * 「业务拒绝」（invalid request 之类）不在此列，不能重试。 */
function isUnknownTier(code, body) {
  if (code !== 400) return false;
  var m = String(dig(body, "msg") || "").toLowerCase();
  return m.indexOf("tier") >= 0 && (m.indexOf("unknown") >= 0 || m.indexOf("unsupported") >= 0 || m.indexOf("invalid") >= 0);
}

/* 未解锁档位：403 + 天数不足 —— 常态而非故障，且必须先于认证判断，
 * 否则未解锁档位会被当成权限拒绝并中止整个成长中心。 */
function isTierLocked(code, body) {
  if (code !== 403) return false;
  var m = String(dig(body, "msg") || "");
  return m.indexOf("不足") >= 0 || /not enough|locked|insufficient/i.test(m);
}

function stepRedeem(next) {
  if (left() <= 0) { parts.push("时间预算耗尽，连登兑换跳过"); return next(); }
  get(GROWTH + "/redeem/summary", function (code, body) {
    if (isAuth(code)) return authFail(code);
    if (note(code, body, "查连登兑换", false)) return next();
    // tier 传档位标识字符串（"7d"/"14d"/"28d"）；第 4 位是兜底用的天数
    var tiers = [["7d", "starter", "入门", 7], ["14d", "advanced", "进阶", 14], ["28d", "legendary", "巅峰", 28]];

    var i = 0;
    (function loop() {
      if (i >= tiers.length || left() <= 0) return next();
      var t = tiers[i++];
      var status = dig(body, t[1] + "_status");
      // 字段缺失（null/空串）同样跳过：接口改版时不该对三档无脑 POST
      if (!status || status === "claimed" || status === "locked") return loop();

      function settle(c2, b2) {
        if (isTierLocked(c2, b2)) {
          parts.push("连登兑换「" + t[2] + "」未解锁（连登天数不足）");
          return loop();
        }
        if (isAuth(c2)) return authFail(c2);
        if (c2 >= 200 && c2 < 300) {
          ctx.credits += asInt(dig(b2, "credit_granted"));
          ctx.ok++;
          parts.push("连登兑换「" + t[2] + "」" + redeemRewardDesc(b2, t[0]));
        } else {
          parts.push("连登兑换「" + t[2] + "」失败：" + (String(dig(b2, "msg") || "") || httpLabel(c2)));
          ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0;
        }
        loop();
      }

      post(GROWTH + "/redeem", { tier: t[0], client_token: clientToken() }, function (c2, b2) {
        if (isUnknownTier(c2, b2)) {
          return post(GROWTH + "/redeem", { tier: t[3], client_token: clientToken() }, settle);
        }
        settle(c2, b2);
      });
    })();
  });
}

function stepLottery(next) {
  if (left() <= 0) { parts.push("时间预算耗尽，盲盒跳过"); return next(); }
  get(GROWTH + "/lottery/chances", function (code, body) {
    if (isAuth(code)) return authFail(code);
    var chances = note(code, body, "查抽奖机会", false) ? 0 : asInt(dig(body, "balance"));
    if (chances <= 0) return next();
    post(GROWTH + "/lottery/draw", { client_token: clientToken() }, function (c2, b2) {
      if (isAuth(c2)) return authFail(c2);
      if (c2 >= 200 && c2 < 300) {
        var prize = dig(b2, "prize_name") || dig(b2, "prize") || "未知";
        if (typeof prize !== "string") prize = String(prize);
        if (dig(b2, "need_address") || dig(b2, "require_address")) prize += "（实物奖，需到成长中心填写收件信息）";
        ctx.ok++;
        parts.push("开盲盒获得：" + prize);
        if (chances > 1) parts.push("还剩 " + (chances - 1) + " 次抽奖机会，下轮继续");
      } else {
        var msg = String(dig(b2, "msg") || "");
        if (msg.toLowerCase().indexOf("no chance") >= 0 || msg.indexOf("无") >= 0) parts.push("开盲盒：" + msg);
        else { parts.push("开盲盒失败：" + (msg || httpLabel(c2))); ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0; }
      }
      next();
    });
  });
}

function stepBuddy(next) {
  if (left() <= 0) { parts.push("时间预算耗尽，Buddy 盲盒跳过"); return next(); }
  get(GROWTH + "/buddy/quota", function (code, body) {
    if (isAuth(code)) return authFail(code);
    if (note(code, body, "查 Buddy 能量", false)) return next();
    var affordable = asInt(dig(body, "affordable"));
    var maxOpen = asInt(dig(body, "max_open_count"), 1) || 1;
    if (affordable <= 0) return next();
    var count = Math.min(affordable, maxOpen);
    post(GROWTH + "/buddy/open", { count: count, client_token: clientToken() }, function (c2, b2) {
      if (isAuth(c2)) return authFail(c2);
      if (c2 >= 200 && c2 < 300) {
        var name = dig(b2, "buddy") || dig(b2, "name") || dig(b2, "buddies");
        if (typeof name !== "string") name = "新 Buddy";
        ctx.ok++;
        parts.push("开 Buddy 盲盒 ×" + count + "（" + name + "）");
      } else {
        parts.push("开 Buddy 盲盒失败：" + String(dig(b2, "msg") || httpLabel(c2)));
        ctx.fail++; ctx.hard += isHard(c2) ? 1 : 0;
      }
      next();
    });
  });
}

/* ---------------- 流程编排 ---------------- */

function run(steps) {
  var i = 0;
  function next() {
    if (ctx.ended) return;
    if (i >= steps.length) return finish(ctx.result || (ctx.ok ? "SUCCESS" : "OK"));
    if (left() <= 0) { parts.push("时间预算耗尽，剩余步骤跳过"); return finish(ctx.result || "OK"); }
    var fn = steps[i++];
    try { fn(next); } catch (e) { parts.push("步骤异常：" + e); ctx.fail++; ctx.hard++; next(); }
  }
  next();
}

/* ---------------- 多账号：账号池解析 ---------------- */

function stamp(ms) {
  try {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  } catch (e) { return "?"; }
}

/* 兼容两种写法：
 *   A. 切号工具导出：{nickname, access_token, uid, domain, enterpriseId, expiresAt, profile_raw, auth_raw}
 *   B. 手写简写：    {name, token, uid, domain, enterpriseId}                                  */
function normAccount(o, idx) {
  if (!o || typeof o !== "object") return null;
  var prof = (o.profile_raw && typeof o.profile_raw === "object") ? o.profile_raw : {};
  var auth = (o.auth_raw && typeof o.auth_raw === "object") ? o.auth_raw : {};
  var token = o.access_token || o.accessToken || o.token || auth.accessToken || "";
  if (!token || typeof token !== "string") return null;
  token = token.replace(/^Bearer\s+/i, "").trim();
  if (token.length < 20) return null;

  var uid = o.uid || o.userId || o.user_id || prof.uid || "";
  var nick = String(o.nickname || o.nick || o.name || prof.nickname || "");
  var alias = String(o.note || "");
  var name = nick || alias || ("账号 " + (idx + 1));
  if (nick && alias && alias !== nick) name = nick + "（" + alias + "）";

  return {
    name: name,
    token: token,
    uid: uid ? String(uid) : "",
    enterpriseId: String(o.enterpriseId || o.enterprise_id || ""),
    domain: String(o.domain || auth.domain || ""),
    expiresAt: asInt(o.expiresAt || o.expires_at, 0),
    // 手机登录页换来的令牌带这两个字段：refresh_token 用来续期，client 是签发它的客户端
    // （续期必须用同一个 client，所以得记住）
    refreshToken: String(o.refresh_token || o.refreshToken || auth.refreshToken || ""),
    client: String(o.client || o.client_id || ""),
    needRefresh: false
  };
}

function expired(a) { return a.expiresAt > 1e12 && a.expiresAt - 60000 < Date.now(); }

function loadAccounts() {
  var out = { list: [], skipped: [] };
  var raw = store("WorkBuddy_Accounts", "");
  var arr = [];

  if (raw) {
    var data = null;
    try { data = JSON.parse(raw); } catch (e) {
      out.skipped.push({ name: "账号列表", reason: "JSON 解析失败，请检查 WorkBuddy_Accounts 内容" });
    }
    if (data) {
      arr = data;
      if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
      if (arr && typeof arr === "object" && !arr.length) {
        arr = data.accounts || data.list || data.records || data.data || data.result || [];
      }
      if (arr && !arr.length && typeof arr === "object" && (arr.access_token || arr.token)) arr = [arr];
      if (!arr || typeof arr.length !== "number") arr = [];
    }
  }

  var seen = {};
  for (var i = 0; i < arr.length; i++) {
    var a = normAccount(arr[i], i);
    if (!a) { out.skipped.push({ name: "账号 " + (i + 1), reason: "缺少可用的 access_token" }); continue; }
    if (!a.uid) { out.skipped.push({ name: a.name, reason: "缺少 uid（X-User-Id）" }); continue; }
    if (seen[a.uid]) { out.skipped.push({ name: a.name, reason: "uid 与前面的账号重复" }); continue; }
    if (expired(a)) {
      // 有 refresh_token 就别急着丢：登录页换来的令牌可以自己续期
      if (!a.refreshToken) { out.skipped.push({ name: a.name, reason: "令牌已过期（" + stamp(a.expiresAt) + "）" }); continue; }
      a.needRefresh = true;
    }
    seen[a.uid] = true;
    out.list.push(a);
  }

  // 没有配账号池时回退到原来的单账号键
  if (!out.list.length && store("WorkBuddy_Token")) {
    out.list.push({
      name: store("WorkBuddy_Name") || "默认账号",
      token: store("WorkBuddy_Token").replace(/^Bearer\s+/i, ""),
      uid: store("WorkBuddy_Uid"),
      enterpriseId: store("WorkBuddy_EnterpriseId"),
      domain: store("WorkBuddy_Domain"),
      expiresAt: 0
    });
  }
  return out;
}

/* 可选：账号池放在自己的 URL 上（WorkBuddy_AccountsURL），省得在手机上粘贴长 JSON。
 * 拉到就直接缓存进 WorkBuddy_Accounts，之后即使拉不到也还能用缓存。 */
function parseAccountsText(raw) {
  var out = { list: [], skipped: [] }, data = null, arr = [];
  try { data = JSON.parse(raw); } catch (e) {
    out.skipped.push({ name: "账号列表", reason: "JSON 解析失败" });
    return out;
  }
  arr = data;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
  if (arr && typeof arr === "object" && !arr.length) arr = data.accounts || data.list || data.records || data.data || data.result || [];
  if (arr && !arr.length && typeof arr === "object" && (arr.access_token || arr.token)) arr = [arr];
  if (!arr || typeof arr.length !== "number" || arr.length > 100) {
    out.skipped.push({ name: "账号列表", reason: arr && arr.length > 100 ? "账号数量超过 100" : "数据结构无效" });
    return out;
  }
  var seen = {};
  for (var i = 0; i < arr.length; i++) {
    var a = normAccount(arr[i], i);
    if (!a) { out.skipped.push({ name: "账号 " + (i + 1), reason: "缺少可用的 access_token" }); continue; }
    if (!a.uid) { out.skipped.push({ name: a.name, reason: "缺少 uid（X-User-Id）" }); continue; }
    if (seen[a.uid]) { out.skipped.push({ name: a.name, reason: "uid 与前面的账号重复" }); continue; }
    if (expired(a)) {
      if (!a.refreshToken) { out.skipped.push({ name: a.name, reason: "令牌已过期（" + stamp(a.expiresAt) + "）" }); continue; }
      a.needRefresh = true;
    }
    seen[a.uid] = true;
    out.list.push(a);
  }
  return out;
}

function loadAccountsFromURL(url, cb) {
  url = String(url || "").replace(/^\s+|\s+$/g, "");
  if (!/^https:\/\//i.test(url)) {
    return cb({ list: [], skipped: [{ name: "账号 URL", reason: "仅允许 HTTPS 地址" }] });
  }
  fetchPlain(url, function (code, data, finalUrl) {
    if (finalUrl && !/^https:\/\//i.test(finalUrl)) {
      return cb({ list: [], skipped: [{ name: "账号 URL", reason: "检测到非 HTTPS 重定向，已拒绝" }] });
    }
    if (code < 200 || code >= 300 || !data) {
      return cb({ list: [], skipped: [{ name: "账号 URL", reason: "拉取失败（" + httpLabel(code) + "）" }] });
    }
    if (data.length > 1024 * 1024) {
      return cb({ list: [], skipped: [{ name: "账号 URL", reason: "响应超过 1 MiB，已拒绝" }] });
    }
    var info = parseAccountsText(data);
    if (!info.list.length) {
      info.skipped.unshift({ name: "账号 URL", reason: "远程内容没有可用账号，未覆盖本地缓存" });
      return cb(info);
    }
    if (!save("WorkBuddy_Accounts", data)) {
      info.skipped.push({ name: "账号 URL", reason: "远程账号可用，但缓存写入失败" });
    }
    cb(info);
  });
}

/* ---------------- 多账号：逐账号驱动 ---------------- */

function startAccount(a) {
  ACC = a;
  parts = [];
  ctx = { ok: 0, fail: 0, hard: 0, credits: 0, result: "", ended: false, done: endAccount };
  T0 = Date.now();
  log("▸ " + ACC.name + "（uid " + (ACC.uid || "无") + "）开始，预算 " + Math.floor(BUDGET) +
      "s，成长中心=" + (flag("WorkBuddy_EnableGrowth", "1") ? "开" : "关") +
      "，盲盒=" + (flag("WorkBuddy_EnableBuddyOpen", "1") ? "开" : "关"));

  var steps = [stepCheckin];
  if (flag("WorkBuddy_EnableGrowth", "1")) {
    steps.push(stepTravel, stepTasks, stepMakeup, stepRedeem, stepLottery);
    if (flag("WorkBuddy_EnableBuddyOpen", "1")) steps.push(stepBuddy);
  }
  run(steps);
}

function endAccount() {
  log("◂ " + ACC.name + " → " + (ctx.result || "OK") + "：" + (ctx.text || "无操作"));
  RESULTS.push({
    name: ACC.name, uid: ACC.uid, result: ctx.result || "OK", report: ctx.text || "无操作",
    ok: ctx.ok, credits: ctx.credits, failures: ctx.fail, hard: ctx.hard
  });
  nextAccount();
}

function nextAccount() {
  if (accIndex >= ACCOUNTS.length) return finalize();
  if (runLeft() <= 10) {
    for (var k = accIndex; k < ACCOUNTS.length; k++) {
      RESULTS.push({ name: ACCOUNTS[k].name, uid: ACCOUNTS[k].uid, result: "SKIPPED", report: "总预算耗尽，本轮跳过" });
    }
    return finalize();
  }
  startAccount(ACCOUNTS[accIndex++]);
}

var RANK = {
  "NETWORK": 7, "TIMEOUT": 6, "AUTH_ERROR": 5, "AUTH_REJECTED": 5,
  "ERROR": 4, "NO_AUTH": 4, "SUCCESS": 4, "ALREADY": 3, "INACTIVE": 2, "OK": 1, "SKIPPED": 0
};

function finalize() {
  if (FINALIZED) return;
  FINALIZED = true;

  var lines = [];
  var errRank = 0, errState = "";
  var okSum = 0, failSum = 0, hardSum = 0, creditsSum = 0;
  var anySuccess = false, anyAlready = false, allInactive = true;

  for (var i = 0; i < RESULTS.length; i++) {
    var r = RESULTS[i];
    okSum += r.ok || 0;
    failSum += r.failures || 0;
    hardSum += r.hard || 0;
    creditsSum += r.credits || 0;
    if (r.result === "SUCCESS") anySuccess = true;
    if (r.result === "ALREADY") anyAlready = true;
    if (r.result !== "INACTIVE") allInactive = false;
    if (ERROR_STATES[r.result] && (RANK[r.result] || 0) > errRank) { errRank = RANK[r.result] || 0; errState = r.result; }
  }

  var multi = RESULTS.length > 1 || ACCOUNTS.length > 1;
  if (multi) {
    for (var m = 0; m < RESULTS.length; m++) lines.push(RESULTS[m].name + "：" + (RESULTS[m].report || "无操作"));
  } else if (RESULTS.length) {
    lines.push(RESULTS[0].report || "无操作");
  }
  for (var j = 0; j < SKIPPED.length; j++) lines.push(SKIPPED[j].name + "：已跳过（" + SKIPPED[j].reason + "）");

  // 令牌临期预警：3 天内就到期的账号提前提醒，别等某天早上发现签到全挂了
  var soon = [];
  for (var q = 0; q < ACCOUNTS.length; q++) {
    var acc = ACCOUNTS[q];
    if (acc.expiresAt > 1e12) {
      var days = (acc.expiresAt - Date.now()) / 86400000;
      if (days < 3) {
        soon.push(acc.name + "（" + stamp(acc.expiresAt) + "，" +
          (days > 0 ? "约 " + Math.max(1, Math.ceil(days)) + " 天内过期" : "已过期") + "）");
      }
    }
  }
  if (soon.length) lines.push("⚠️ 令牌即将过期：" + soon.join("、") + " —— 到期后会自动续期；续不了就去手机登录页重登：" + LOGIN_URL);
  if (RENEWED.length) lines.push("⟳ 已自动续期：" + RENEWED.join("、"));
  if (!lines.length) lines.push(ctx.text || "无操作");
  // 全部被跳过时，除了每个账号的原因，再补一行「该怎么办」
  else if (!RESULTS.length && ctx.text && lines.join("\n").indexOf(ctx.text) < 0) lines.push(ctx.text);

  var result;
  if (errState) result = errState;
  else if (!RESULTS.length && ctx.result) result = ctx.result;
  else if (anySuccess) result = "SUCCESS";
  else if (anyAlready) result = "ALREADY";
  else if (allInactive && RESULTS.length) result = "INACTIVE";
  else result = "OK";

  var text = lines.join("\n");
  var out = { result: result, report: text, time: now(), accounts: RESULTS };
  if (creditsSum) out.credits = creditsSum;
  if (failSum) out.failures = failSum;
  if (hardSum) out.needs_attention = true;
  if (soon.length) out.expiring = soon.length;

  save("WorkBuddy_LastReport", text);
  save("WorkBuddy_LastResult", result);
  save("WorkBuddy_LastTime", now());
  save("WorkBuddy_LastJSON", JSON.stringify(out));

  var quiet = (argument() === "poll" || argument() === "silent");
  var verbose = flag("WorkBuddy_LogEmpty", "0");
  log("── WorkBuddy 结束：" + result + (creditsSum ? " +" + creditsSum + " 积分" : "") +
      "（成功 " + okSum + " 次" + (failSum ? "，失败 " + failSum + " 次" : "") + "）──");
  log(text);
  var worth = hardSum > 0 || !!ERROR_STATES[result] || anySuccess || okSum > 0 || result === "INACTIVE" || soon.length > 0;
  if (!quiet || verbose || worth) {
    var title = "WorkBuddy 签到" + (multi ? "（" + RESULTS.length + " 个账号）" : "");
    var sub = (STATUS_HINT[result] ? result + "：" + STATUS_HINT[result] : result) + (creditsSum ? " +" + creditsSum + " 积分" : "");
    notify(title, sub, trunc(text, 700));
  }
  try { if (typeof $done !== "undefined") $done(); } catch (e) {}
}

/* ---------------- 手机登录 / 自动续期 ---------------- */

/* Keycloak 令牌端点：application/x-www-form-urlencoded（不是 JSON） */
function kcToken(body, cb) {
  var pairs = [];
  for (var k in body) {
    if (!body.hasOwnProperty(k) || body[k] === undefined || body[k] === null) continue;
    pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(body[k])));
  }
  $httpClient.post({
    url: KC_TOKEN,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: pairs.join("&")
  }, function (err, resp, data) {
    var code = 0;
    try { code = asInt((resp && (resp.status || resp.statusCode)) || 0, 0); } catch (e) {}
    var json = null;
    try { json = JSON.parse(data); } catch (e) {}
    var okc = (code >= 200 && code < 300);
    // 日志只打长度和错误码，绝不打印令牌
    log((okc ? "· " : "× ") + "TOKEN " + (body.grant_type || "") + " → " + code +
        (okc ? "" : "  " + trunc((json && (json.error_description || json.error)) || String(data || ""), 140)));
    if (err) return cb(-1, { error: String(err) });
    cb(code, json || { raw: String(data == null ? "" : data).slice(0, 200) });
  });
}

var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64decode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
  var out = "", buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64C.indexOf(s.charAt(i));
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xFF); }
  }
  return out;
}

/* 只读 JWT 载荷。别做签名校验——令牌是服务端签的，我们只取 sub/nickname/exp */
function jwtPayload(tok) {
  try {
    var raw = b64decode(String(tok).split(".")[1]);
    try { raw = decodeURIComponent(escape(raw)); } catch (e) {}
    return JSON.parse(raw);
  } catch (e) { return {}; }
}

/* 账号池里的一条记录（字段名与切号工具导出的 JSON 对齐） */
function poolRecord(tokRes, clientId) {
  var pl = jwtPayload(tokRes.access_token || "");
  return {
    nickname: String(pl.nickname || pl.preferred_username || pl.name || "账号"),
    access_token: String(tokRes.access_token || ""),
    refresh_token: String(tokRes.refresh_token || ""),
    uid: String(pl.sub || ""),
    expiresAt: pl.exp ? pl.exp * 1000 : 0,
    domain: "www.codebuddy.cn",
    client: clientId,
    refreshedAt: Date.now()
  };
}

/* 写回账号池：同 uid 覆盖（保留原有 nickname 等字段），新 uid 追加 */
function upsertPool(rec, cb) {
  var raw = store("WorkBuddy_Accounts", "");
  var data = [];
  if (raw) {
    try { data = JSON.parse(raw); } catch (e) { data = []; }
  }
  if (data && !Array.isArray(data)) data = data.accounts || data.list || data.records || data.data || [];
  if (!Array.isArray(data)) data = [];

  var found = -1;
  for (var i = 0; i < data.length; i++) {
    var o = data[i] || {};
    var prof = (o.profile_raw && typeof o.profile_raw === "object") ? o.profile_raw : {};
    if (String(o.uid || prof.uid || "") === String(rec.uid)) { found = i; break; }
  }
  if (found >= 0) {
    var old = data[found];
    old.access_token = rec.access_token;
    if (rec.refresh_token) old.refresh_token = rec.refresh_token;
    if (rec.client) old.client = rec.client;
    old.expiresAt = rec.expiresAt;
    old.refreshedAt = rec.refreshedAt;
    if (!old.nickname) old.nickname = rec.nickname;
    if (!old.uid) old.uid = rec.uid;
  } else {
    data.push(rec);
  }
  save("WorkBuddy_Accounts", JSON.stringify(data));
  log("⤴ 账号池已更新：" + (found >= 0 ? "覆盖" : "新增") + "「" + rec.nickname + "」，共 " + data.length + " 条");
  if (cb) cb(found >= 0, data.length);
}

/* 用 refresh_token 换新令牌。只有签发它的客户端能续，所以 client 必须跟着记录一起存 */
function doRefresh(a, cb) {
  var clientId = a.client || store("WorkBuddy_LoginClient", "account-console");
  kcToken({
    grant_type: "refresh_token", client_id: clientId, refresh_token: a.refreshToken, scope: KC_SCOPE
  }, function (code, tok) {
    if (code === -1) return cb(false, "网络不可达");
    if (!(code >= 200 && code < 300) || !tok || !tok.access_token) {
      var why = (tok && (tok.error_description || tok.error)) || httpLabel(code);
      return cb(false, trunc(why, 140));
    }
    var rec = poolRecord(tok, clientId);
    a.token = rec.access_token;
    if (rec.expiresAt) a.expiresAt = rec.expiresAt;
    if (rec.refresh_token) a.refreshToken = rec.refresh_token;
    a.needRefresh = false;
    upsertPool(rec);
    cb(true, "");
  });
}

/* 每轮开始前，先把过期/临期的账号续掉（续期失败的踢出本轮，避免拿废令牌去打接口） */
function refreshPass(cb) {
  var queue = [];
  for (var i = 0; i < ACCOUNTS.length; i++) {
    var a = ACCOUNTS[i];
    if (!a.refreshToken) continue;
    if (a.needRefresh || (a.expiresAt > 1e12 && a.expiresAt - Date.now() < 86400000)) queue.push(a);
  }
  if (!queue.length) return cb();
  log("⟳ 需要续期的账号：" + queue.length + " 个");
  var idx = 0;
  (function one() {
    if (idx >= queue.length) return cb();
    var a = queue[idx++];
    doRefresh(a, function (ok, why) {
      if (ok) { RENEWED.push(a.name); log("⟳ " + a.name + "：已自动续期"); }
      else { a.renewFailed = why; a.token = ""; log("⟳ " + a.name + "：续期失败（" + why + "）"); }
      one();
    });
  })();
}

/* argument=login：Loon 拦下 Keycloak 的登录回调，我们直接把 code 换成令牌
 * （脚本里换没有跨域问题，也不用把码贴来贴去） */
// 换完令牌后让浏览器跳回登录页看结果。
// http-request 脚本可以直接造一个假响应（$done({response:{status,headers,body}})，见 Loon 脚本文档），
// 所以这里回一个 302：登录成功回到「✅ 已写入账号池」，失败回到带原因的页面 —— 无论成败都有明确反馈。
function loginAnswer(kind, name, msg) {
  var q;
  if (kind === "ok") q = "?ok=1&name=" + encodeURIComponent(name || "");
  else if (kind === "warn") q = "?warn=1&name=" + encodeURIComponent(name || "") + "&msg=" + encodeURIComponent(trunc(msg || "", 160));
  else q = "?err=" + encodeURIComponent(trunc(msg || "登录没有完成", 200));
  return { response: { status: 302, headers: { Location: LOGIN_URL + q }, body: "" } };
}

// 把登录页当作 HTTP 响应直接吐出去（argument=page，由插件的「WorkBuddy登录页」规则触发）。
// 页面地址是 https://www.codebuddy.cn/wb-login：这个域名本来就要 MITM（登录回调也要），
// 所以只要 Loon 通就一定打得开，不用管 github.io / jsDelivr 能不能访问。
function servePage() {
  log("⇢ 输出登录页：HTML " + PAGE_HTML.length + " 字节");
  return $done({
    response: {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      body: PAGE_HTML
    }
  });
}

function serveLoginSession() {
  var reqUrl = String(($request && $request.url) || "");
  var method = String(($request && $request.method) || "GET").toUpperCase();
  var origin = "";
  try {
    var rh = ($request && $request.headers) || {};
    origin = String(rh.Origin || rh.origin || "");
  } catch (e) {}
  var reply = function (status, obj) {
    var headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (origin === "https://xlzs001.github.io") {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
      headers["Vary"] = "Origin";
    }
    return $done({ response: { status: status, headers: headers, body: JSON.stringify(obj) } });
  };
  if (!/^https:\/\/www\.codebuddy\.cn\/wb-login\/session(?:[?#]|$)/i.test(reqUrl)) return reply(404, { error: "not_found" });
  if (method === "OPTIONS") return reply(204, {});
  if (method !== "POST") return reply(405, { error: "method_not_allowed" });
  var data = null;
  try { data = JSON.parse(String(($request && $request.body) || "")); } catch (e) {}
  var state = data && String(data.state || "");
  var verifier = data && String(data.verifier || "");
  var client = data && String(data.client || "account-console");
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(state) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^(account-console|account)$/.test(client)) {
    return reply(400, { error: "invalid_login_transaction" });
  }
  var tx = { state: state, verifier: verifier, client: client, createdAt: Date.now() };
  if (!save("WorkBuddy_LoginTransaction", JSON.stringify(tx))) return reply(500, { error: "storage_failed" });
  return reply(204, {});
}

// Keycloak 回调里的 error 值 → 一句人话。
// 为什么非要做这一步：回调地址（redirect_uri）是
//   https://www.codebuddy.cn/auth/realms/copilot/account/
// codebuddy 的网关（APISIX）对 /account/** 这一整段做了来源限制，非白名单 IP 直接回
//   403 {"message":"Your IP address is not allowed"}
// （实测：同一个域名下 /protocol/openid-connect/auth 200、/login-actions/authenticate 400、
//   /protocol/openid-connect/token 400 invalid_grant，只有 /account/** 是 403）。
// 所以这条回调请求**必须**由本脚本在手机本地伪造响应，一旦漏给上面那个网关，
// 用户看到的就是那段看不懂的 JSON —— 包括「带 ?error= 但没有 code=」的回调。
function explainKc(err, desc) {
  var d = trunc(desc || "", 160);
  var tail = d ? "（" + d + "）" : "";
  if (err === "access_denied") return "你在 CodeBuddy 的登录页上点了取消 / 拒绝了授权。" + tail;
  if (err === "invalid_request" && /code_challenge|code_challenge_method/i.test(d))
    return "这次授权请求的 PKCE 参数不全 —— CodeBuddy 的 account-console 强制要求 PKCE(S256)，不带就会被直接打回。别手搓授权链接，回登录页点「用手机号登录」重新来一次。" + tail;
  if (err === "login_required" || err === "interaction_required") return "服务端要求重新登录一次。" + tail;
  if (err === "unauthorized_client" || err === "invalid_client")
    return "这个 client_id 不被接受：登录页「高级」里把 client_id 换成 account（备用）再试。" + tail;
  if (err === "invalid_scope") return "scope 被拒（登录页带的是 openid profile offline_access email）。" + tail;
  if (err === "temporarily_unavailable" || err === "server_error") return "登录服务暂时不可用，过一会儿重试。" + tail;
  return "授权没有完成" + tail;
}

function loginCallback(overrideUrl) {
  // overrideUrl 有值 = 这次不是被 Loon 拦下来的回调，而是用户粘进 BoxJS 的那条地址
  // （手机上没有 MITM 也能用这条路：换令牌是脚本自己发出去的请求，不受浏览器 CORS 限制）。
  var fromJS = (typeof overrideUrl === "string");
  var url = fromJS ? overrideUrl : (($request && $request.url) || "");
  var callbackPrefix = "https://www.codebuddy.cn/auth/realms/copilot/account/";
  var callbackPattern = /^https:\/\/www\.codebuddy\.cn\/auth\/realms\/copilot\/account\/(?:[?#]|$)/i;
  var clientId = store("WorkBuddy_LoginClient", "account-console");
  var tailHint = fromJS ? "\n\n这条地址已从 BoxJS 里清掉；再点一次「立即签到一轮（手动运行）」就会用它签到。" : "";
  var pick = function (k) {
    var mm = String(url).match(new RegExp("[?&]" + k + "=([^&#]+)"));
    if (!mm) return "";
    try { return decodeURIComponent(mm[1].replace(/\+/g, "%20")); } catch (e) { return ""; }
  };
  if (!callbackPattern.test(String(url))) {
    if (fromJS) save("WorkBuddy_LoginCallback", "");
    notify("WorkBuddy 登录失败", "回调地址无效", "只接受 " + callbackPrefix + " 开头的 HTTPS 回调地址。");
    try { $done(loginAnswer("err", "", "回调地址不是预期的 CodeBuddy HTTPS 地址。")); } catch (e) {}
    return;
  }
  var codeStr = pick("code");
  var errStr = pick("error");
  log("⇢ 登录回调：client=" + clientId + "，code 长度=" + codeStr.length +
      (errStr ? "，error=" + errStr : ""));

  var bail = function (title, sub, msg) {
    if (fromJS) {
      save("WorkBuddy_LoginCallback", "");
      msg = String(msg) + "\n\n（已清掉 BoxJS 里那条回调地址，避免以后每一轮都拿它重试；重新登录后再粘一次新的。）";
    }
    notify(title, sub, msg);
    try { $done(loginAnswer("err", "", msg)); } catch (e) {}
  };
  if (errStr) {
    return bail("WorkBuddy 登录没走完", "服务端回了 " + errStr,
      explainKc(errStr, pick("error_description")) +
      "\n\n（这条回调本身没被 Loon 拦下也无所谓，脚本已经拦住了。重新点一次登录即可。）");
  }
  if (!codeStr) return bail("WorkBuddy 登录", "没抓到 code", "回调地址里既没有 code 也没有 error：" + trunc(url, 200));

  var stStr = pick("state");
  var verifier = "", verifierFrom = "", tx = null;
  try { tx = JSON.parse(store("WorkBuddy_LoginTransaction", "") || "null"); } catch (e) {}
  if (!tx || tx.state !== stStr || Date.now() - asInt(tx.createdAt, 0) > 10 * 60 * 1000) {
    save("WorkBuddy_LoginTransaction", "");
    return bail("WorkBuddy 登录失败", "登录事务无效", "state 不匹配或已超过 10 分钟，请从最新版登录页重新登录。");
  }
  verifier = String(tx.verifier || "");
  clientId = String(tx.client || clientId);
  verifierFrom = "transaction";
  save("WorkBuddy_LoginTransaction", "");
  if (!verifier) return bail("WorkBuddy 登录失败", "登录事务无效", "登录事务缺少 PKCE verifier，请重新登录。");
  var body = { grant_type: "authorization_code", client_id: clientId, code: codeStr, redirect_uri: KC_REDIRECT, code_verifier: verifier };
  log("⇢ PKCE verifier 来源：" + (verifierFrom || "无") + (verifier ? "（" + verifier.length + " 字符）" : "（服务端强制 PKCE，这次多半会失败）"));

  kcToken(body, function (code, tok) {
    if (!(code >= 200 && code < 300) || !tok || !tok.access_token) {
      var why = (tok && (tok.error_description || tok.error)) || httpLabel(code);
      return bail("WorkBuddy 登录失败", "换令牌失败", "client=" + clientId + "：" + trunc(why, 240) +
        "\ncode 只有约 1 分钟有效期，过期就回最新版登录页重新登录一次。");
    }
    var rec = poolRecord(tok, clientId);
    if (!rec.uid) return bail("WorkBuddy 登录失败", "令牌里没有 uid", "换到了令牌但缺少 sub 声明，无法当 X-User-Id 用，没有写入账号池。");

    // 立刻拿签到接口验一次：令牌能不能真用（这一步很关键，省得每天跑完才知道不行）
    $httpClient.post({
      url: HOST + "/v2/billing/meter/checkin-activity-status",
      headers: {
        "Accept": "application/json", "Authorization": "Bearer " + rec.access_token,
        "Content-Type": "application/json", "User-Agent": "WorkBuddy",
        "X-User-Id": rec.uid, "X-Domain": rec.domain || "www.codebuddy.cn"
      },
      body: "{}"
    }, function (err2, resp2, data2) {
      var vcode = 0;
      try { vcode = asInt((resp2 && (resp2.status || resp2.statusCode)) || 0, 0); } catch (e) {}
      var vbody = null;
      try { vbody = JSON.parse(data2); } catch (e) {}
      var usable = (vcode === 200 && asInt(dig(vbody, "code"), -1) === 0);
      var extra = "昵称：" + rec.nickname + "\nuid：" + rec.uid +
        "\n有效至：" + (rec.expiresAt ? stamp(rec.expiresAt) : "未知") +
        "\n可续期：" + (rec.refresh_token ? "是（已记住 refresh_token）" : "否（登录时没拿到 offline_access）");

      if (usable) {
        upsertPool(rec);
        if (fromJS) save("WorkBuddy_LoginCallback", "");
        log("✓ 登录成功并验证通过：" + rec.nickname + "（uid " + rec.uid + "）");
        notify("WorkBuddy 登录成功", rec.nickname + " 已写入账号池",
          extra + "\n签到接口验证：可用 ✓\n\n以后令牌到期脚本会自己续期，不用再登录。" + tailHint);
        return answer(loginAnswer("ok", rec.nickname), rec.nickname);
      } else {
        var tail = (vcode === 401 || vcode === 403)
          ? "签到接口回报 " + httpLabel(vcode) + "：这条令牌签不了到（这个客户端签发的令牌可能不被接受）。已写入账号池，不行就在 BoxJS 里删掉这条。"
          : "签到接口回报 " + httpLabel(vcode) + "（" + trunc(String(data2 || ""), 120) + "）。已写入账号池，可手动跑一轮再看。";
        upsertPool(rec);
        if (fromJS) save("WorkBuddy_LoginCallback", "");
        log("! 登录换到令牌但验证失败：HTTP " + vcode);
        notify("WorkBuddy 登录（令牌未验证通过）", rec.nickname + " 已写入账号池", extra + "\n" + tail + tailHint);
        return answer(loginAnswer("warn", rec.nickname, tail), rec.nickname);
      }
    });
  });
}

// 主动结束本轮登录回调：先跳回登录页，再结束脚本
function answer(doneArg, nickname) {
  log("→ 登录回调结束：" + nickname + "，已跳回登录页展示结果");
  try { $done(doneArg); } catch (e) {}
  return undefined;
}

/* ---------------- 入口 ---------------- */

function captureToken() {
  var h = ($request && $request.headers) || {};
  var auth = "", uidH = "", entH = "", domH = "";
  for (var k in h) {
    if (!h.hasOwnProperty(k)) continue;
    var lk = k.toLowerCase();
    if (lk === "authorization") auth = h[k];
    else if (lk === "x-user-id") uidH = h[k];
    else if (lk === "x-enterprise-id" || lk === "x-tenant-id") entH = h[k];
    else if (lk === "x-domain") domH = h[k];
  }
  var token = (auth && auth.indexOf("Bearer ") === 0) ? auth.slice(7).trim() : "";

  // 多账号：按请求头里的 X-User-Id 命中账号池中的那一条，只刷新它
  var hit = "", poolUpdated = false;
  var raw = store("WorkBuddy_Accounts", "");
  if (raw && uidH) {
    try {
      var data = JSON.parse(raw);
      var arr = Array.isArray(data) ? data : (data.accounts || data.list || data.records || []);
      if (arr && arr.length) {
        for (var i = 0; i < arr.length; i++) {
          var rec = arr[i] || {};
          var prof = (rec.profile_raw && typeof rec.profile_raw === "object") ? rec.profile_raw : {};
          if (String(rec.uid || prof.uid || "") !== String(uidH)) continue;
          hit = String(rec.nickname || rec.name || uidH);
          if (token && token.length > 20 && rec.access_token !== token) {
            rec.access_token = token;
            if (rec.auth_raw && typeof rec.auth_raw === "object") rec.auth_raw.accessToken = token;
            rec.expiresAt = 0;           // 不可靠了，交给下一轮实测
            rec.refreshedAt = Date.now();
            save("WorkBuddy_Accounts", JSON.stringify(data));
            poolUpdated = true;
          }
          break;
        }
      }
    } catch (e) {}
  }

  if (uidH) save("WorkBuddy_Uid", uidH);
  if (entH && !store("WorkBuddy_EnterpriseId")) save("WorkBuddy_EnterpriseId", entH);
  if (domH) save("WorkBuddy_Domain", domH);
  if (token && token.length > 20 && token !== store("WorkBuddy_Token")) {
    save("WorkBuddy_Token", token);
    save("WorkBuddy_TokenTime", now());
    if (!poolUpdated) notify("WorkBuddy 令牌已更新", "来自手机端请求", "新的 accessToken 已写入 BoxJS");
  }
  if (poolUpdated) notify("WorkBuddy 令牌已更新", hit || "账号池", "账号池中「" + (hit || "") + "」的 accessToken 已刷新");
  log("⇢ 捕获请求令牌：uid=" + (uidH || "无") + "，令牌长度=" + (token ? token.length : 0) +
      (poolUpdated ? "，已刷新账号池「" + hit + "」" : (hit ? "，与账号池一致" : "，账号池未命中")));
  try { $done({}); } catch (e) {}
}

function panel() {
  var report = store("WorkBuddy_LastReport", "尚未运行过");
  var result = store("WorkBuddy_LastResult", "-");
  var time = store("WorkBuddy_LastTime", "-");
  var n = 0;
  try {
    var j = JSON.parse(store("WorkBuddy_LastJSON", "{}"));
    if (j && j.accounts && j.accounts.length) n = j.accounts.length;
  } catch (e) {}
  try {
    $done({ title: "WorkBuddy" + (n > 1 ? " ×" + n : ""), content: "[" + result + "] " + report + "\n更新：" + time });
  } catch (e) {}
}

/* ==== PAGE_HTML:BEGIN（由 build-page.py 从 login.html 生成，勿手改）==== */
var PAGE_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"color-scheme\" content=\"dark light\">\n<title>WorkBuddy 手机登录</title>\n<style>\n:root{--bg:#080b12;--card:#111724;--card2:#151d2d;--line:#253047;--fg:#f4f7fb;--dim:#97a3b6;--acc:#4f7cff;--acc2:#315ddd;--ok:#22c984;--warn:#f4ad3d;--err:#f15f68}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}\nbody{max-width:560px;margin:0 auto;padding:28px 16px calc(72px + env(safe-area-inset-bottom));background:radial-gradient(circle at 50% -80px,#1c326d 0,#0c1220 34%,var(--bg) 68%);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,\"PingFang SC\",\"Helvetica Neue\",sans-serif}\nh1{font-size:25px;line-height:1.15;margin:5px 0 0;letter-spacing:-.5px}\nh2{font-size:17px;margin:0 0 14px;color:var(--fg)}\np{margin:7px 0}.lead{margin:14px 0 20px;color:#bdc7d8;font-size:14px}.dim{color:var(--dim);font-size:13px}\n.hero{display:flex;align-items:center;gap:13px}.brand{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;background:linear-gradient(145deg,#6e91ff,#365fd8);box-shadow:0 12px 35px #234aaf66;font-size:24px;font-weight:800}\n.card{background:linear-gradient(145deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:18px;padding:18px;margin:14px 0;box-shadow:0 12px 35px #0004}.card.primary{border-color:#3e5fa8;box-shadow:0 18px 50px #102b7055}.requirements{padding:15px 18px}\n.btn{display:block;width:100%;min-height:50px;padding:13px 16px;border:0;border-radius:13px;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;font-size:16px;font-weight:700;margin:15px 0 0;text-align:center;text-decoration:none;box-shadow:0 8px 22px #274fb255;cursor:pointer}.btn.sec{background:#202a3c;color:var(--fg);box-shadow:none;font-weight:600;font-size:14px}.btn:active{transform:translateY(1px);opacity:.86}.btn:disabled{opacity:.58;cursor:wait}\ntextarea,input,select{width:100%;background:#090d16;color:var(--fg);border:1px solid var(--line);border-radius:11px;padding:11px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}textarea{min-height:96px;resize:vertical}select{margin-top:6px}code{background:#080c14;border:1px solid var(--line);border-radius:6px;padding:1px 5px;font-size:12px;word-break:break-all}\n.row{display:flex;gap:9px}.row>*{flex:1}.tag{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid #2c765b;color:#61d9a6;background:#14372d}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}\n.flow{position:relative;margin:4px 0 17px}.flow:before{content:\"\";position:absolute;left:15px;top:28px;bottom:28px;width:2px;background:#29354b}.flow-item{position:relative;display:flex;gap:12px;align-items:center;padding:8px 0;color:#8f9bb0}.flow-item i{position:relative;z-index:1;display:grid;place-items:center;width:32px;height:32px;flex:0 0 32px;border-radius:50%;background:#20293a;border:1px solid #344159;font-style:normal;font-size:13px;font-weight:700}.flow-item span{display:flex;flex-direction:column}.flow-item b{font-size:14px}.flow-item small{font-size:12px}.flow-item.active{color:var(--fg)}.flow-item.active i{background:var(--acc);border-color:#82a0ff}.flow-item.done{color:#a9e7cc}.flow-item.done i{background:#176545;border-color:var(--ok)}\n.hint,.safe-note{font-size:12.5px;color:var(--dim)}.safe-note{padding:10px 11px;margin-top:12px;border-radius:10px;background:#0c251d;border:1px solid #2b7659;color:#b9f1d9}.check{display:flex;gap:9px;align-items:flex-start;padding:6px 0;color:#bac5d5;font-size:13px}.check b{color:var(--ok)}\n.kv{font-size:13px;margin:4px 0;word-break:break-all}.kv b{color:var(--dim);font-weight:500}details{margin-top:10px}details.compact{padding-top:4px}details.recovery>summary{font-size:14px;color:#c0cada;font-weight:600}summary{cursor:pointer;color:var(--dim);font-size:13px}footer{text-align:center;color:#8793a7;font-size:12px;padding:12px 0 4px}footer p{margin:4px 0}\n@media(max-width:390px){body{padding-left:12px;padding-right:12px}.row{display:block}.row .btn{margin-top:9px}}\n</style>\n</head>\n<body>\n\n<header class=\"hero\">\n  <div class=\"brand\">W</div>\n  <div><span class=\"tag ok\">全自动登录</span><h1>连接 WorkBuddy</h1></div>\n</header>\n<p class=\"lead\">只需完成手机号验证，后续获取令牌、校验账号、写入账号池和启用自动续期全部自动完成。</p>\n\n<!-- Loon 换完令牌后带着 ?ok / ?warn / ?err 回到这里 -->\n<div id=\"banner\"></div>\n\n<main id=\"loginCard\" class=\"card primary\">\n  <h2>一键完成配置</h2>\n  <div class=\"flow\" id=\"flow\">\n    <div class=\"flow-item active\" id=\"flowPrepare\"><i>1</i><span><b>建立安全连接</b><small>创建一次性 PKCE 登录事务</small></span></div>\n    <div class=\"flow-item\" id=\"flowAuth\"><i>2</i><span><b>手机号验证</b><small>前往 CodeBuddy 完成登录</small></span></div>\n    <div class=\"flow-item\" id=\"flowSave\"><i>3</i><span><b>自动配置完成</b><small>获取并验证令牌，写入 BoxJS</small></span></div>\n  </div>\n  <button class=\"btn\" id=\"go\">开始安全登录</button>\n  <p class=\"hint\" id=\"goHint\">登录完成后会自动返回本页，无需复制地址、令牌或打开 BoxJS。</p>\n  <div class=\"safe-note\">令牌不会出现在网址中；一次性登录事务在使用后立即销毁。</div>\n\n  <details class=\"compact\">\n    <summary>高级设置</summary>\n    <label class=\"dim\" for=\"client\">登录客户端</label>\n    <select id=\"client\">\n      <option value=\"account-console\" selected>account-console（推荐）</option>\n      <option value=\"account\">account（备用）</option>\n    </select>\n  </details>\n</main>\n\n<section class=\"card requirements\">\n  <h2>使用条件</h2>\n  <div class=\"check\"><b>✓</b><span>已安装最新版 WorkBuddy Loon 插件</span></div>\n  <div class=\"check\"><b>✓</b><span>Loon 的 MITM 已开启并信任证书</span></div>\n  <div class=\"check\"><b>✓</b><span>MITM hostname 包含 <code>www.codebuddy.cn</code></span></div>\n</section>\n\n<details class=\"card recovery\">\n  <summary>登录没有自动返回？打开故障恢复</summary>\n  <p class=\"dim\">正常流程不需要此步骤。仅当登录后停在 CodeBuddy 回调页时，复制地址栏中的完整 HTTPS 地址粘贴到这里。</p>\n  <textarea id=\"cb\" placeholder=\"https://www.codebuddy.cn/auth/realms/copilot/account/?state=...&code=...\"></textarea>\n  <div class=\"row\">\n    <button class=\"btn sec\" id=\"paste\">粘贴地址</button>\n    <button class=\"btn\" id=\"ex\">继续自动配置</button>\n  </div>\n  <div id=\"exOut\"></div>\n</details>\n\n<!-- 仅故障恢复流程使用；正常自动流程由 Loon 直接写入 BoxJS -->\n<div class=\"card\" id=\"outCard\" style=\"display:none\">\n  <h2>手动恢复结果</h2>\n  <div id=\"info\"></div>\n  <textarea id=\"pool\" readonly style=\"min-height:130px\"></textarea>\n  <div class=\"row\">\n    <button class=\"btn sec\" id=\"copyPool\">复制账号数据</button>\n    <button class=\"btn sec\" id=\"verify\">验证令牌</button>\n  </div>\n  <div id=\"verifyOut\"></div>\n</div>\n\n<details class=\"card recovery\">\n  <summary>维护工具</summary>\n  <div id=\"sess\" class=\"dim\">当前页面没有登录记录。</div>\n  <textarea id=\"rt\" placeholder=\"refresh_token\"></textarea>\n  <button class=\"btn sec\" id=\"refresh\">手动续期</button>\n  <div id=\"rfOut\"></div>\n</details>\n\n<footer>\n  <span id=\"src\"></span>\n  <p>登录采用 PKCE S256；敏感令牌仅由本机 Loon 写入 BoxJS，不上传到第三方。</p>\n</footer>\n\n<script>\n/* ---------- 常量：来自 realm 的 .well-known/openid-configuration ---------- */\nvar ISSUER   = \"https://www.codebuddy.cn/auth/realms/copilot\";\nvar AUTH_EP  = ISSUER + \"/protocol/openid-connect/auth\";\nvar TOKEN_EP = ISSUER + \"/protocol/openid-connect/token\";\nvar REDIRECT = ISSUER + \"/account/\";\nvar SCOPE    = \"openid profile offline_access email\";\nvar API_BASE = \"https://copilot.tencent.com\";\n\n/* 敏感令牌与 PKCE 事务只留在当前页面内存中；刷新/关闭后自动清除。 */\nvar MEM = {};\nvar LS = {\n  get: function (k) { return MEM[k] || \"\"; },\n  set: function (k, v) { MEM[k] = v; },\n  del: function (k) { delete MEM[k]; }\n};\nvar TX = {\n  get: function (k) { try { return sessionStorage.getItem(\"wb_tx_\" + k) || \"\"; } catch (e) { return MEM[\"tx_\" + k] || \"\"; } },\n  set: function (k, v) { MEM[\"tx_\" + k] = v; try { sessionStorage.setItem(\"wb_tx_\" + k, v); } catch (e) {} },\n  clear: function () {\n    delete MEM.tx_state; delete MEM.tx_verifier; delete MEM.tx_client;\n    try { sessionStorage.removeItem(\"wb_tx_state\"); sessionStorage.removeItem(\"wb_tx_verifier\"); sessionStorage.removeItem(\"wb_tx_client\"); } catch (e) {}\n  }\n};\nfunction $(id) { return document.getElementById(id); }\nfunction esc(s) { return String(s == null ? \"\" : s).replace(/[&<>\"]/g, function (c) {\n  return ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\" })[c]; }); }\nfunction b64u(buf) {\n  var b = new Uint8Array(buf), s = \"\";\n  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);\n  return btoa(s).replace(/\\+/g, \"-\").replace(/\\//g, \"_\").replace(/=+$/, \"\");\n}\nfunction rand(n) {\n  var a = new Uint8Array(n);\n  (window.crypto || window.msCrypto).getRandomValues(a);\n  var s = \"\";\n  for (var i = 0; i < a.length; i++) s += (\"0\" + (a[i] % 36).toString(36)).slice(-1);\n  return s;\n}\nfunction sha256(txt) {\n  var data = new TextEncoder().encode(txt);\n  return window.crypto.subtle.digest(\"SHA-256\", data).then(b64u);\n}\nfunction jwt(tok) {\n  try {\n    var p = tok.split(\".\")[1].replace(/-/g, \"+\").replace(/_/g, \"/\");\n    p += \"====\".slice(0, (4 - p.length % 4) % 4);\n    return JSON.parse(decodeURIComponent(escape(atob(p))));\n  } catch (e) { return {}; }\n}\nfunction fmt(expSec) {\n  if (!expSec) return \"未知\";\n  var d = new Date(expSec * 1000);\n  function p(n) { return (n < 10 ? \"0\" : \"\") + n; }\n  return d.getFullYear() + \"-\" + p(d.getMonth() + 1) + \"-\" + p(d.getDate()) + \" \" + p(d.getHours()) + \":\" + p(d.getMinutes());\n}\nfunction say(el, cls, html) { el.innerHTML = '<p class=\"' + cls + '\">' + html + \"</p>\"; }\n\n/* ---------- ① 登录 ---------- */\nfunction flow(step) {\n  var ids = [\"flowPrepare\", \"flowAuth\", \"flowSave\"];\n  for (var i = 0; i < ids.length; i++) {\n    var el = $(ids[i]);\n    el.className = \"flow-item\" + (i < step ? \" done\" : (i === step ? \" active\" : \"\"));\n    el.querySelector(\"i\").textContent = i < step ? \"✓\" : String(i + 1);\n  }\n}\nfunction setBusy(on, text) {\n  var b = $(\"go\");\n  b.disabled = !!on;\n  b.textContent = text || (on ? \"正在建立安全连接…\" : \"开始安全登录\");\n}\n$(\"go\").onclick = function () {\n  var client = $(\"client\").value;\n  setBusy(true, \"正在建立安全连接…\");\n  flow(0);\n  $(\"goHint\").textContent = \"正在创建一次性登录事务，请勿关闭页面。\";\n  LS.set(\"client\", client);\n  TX.set(\"client\", client);\n  // account-console 在服务端强制 PKCE(S256)：不带 code_challenge_method 会被直接打回\n  //   .../account/?error=invalid_request&error_description=Missing+parameter%3A+code_challenge_method\n  // 所以这里没有「关掉」这个选项。\n  if (!window.crypto || !window.crypto.subtle) {\n    setBusy(false);\n    $(\"goHint\").innerHTML = '<span class=\"err\">当前页面不是安全 HTTPS 环境，无法建立 PKCE 登录。</span>';\n    return;\n  }\n  var verifier = rand(32) + rand(32);\n  var state = rand(32);\n  TX.set(\"verifier\", verifier);\n  TX.set(\"state\", state);\n  sha256(verifier).then(function (ch) {\n    var sessionUrl = \"https://www.codebuddy.cn/wb-login/session\";\n    return fetch(sessionUrl, {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ state: state, verifier: verifier, client: client })\n    }).then(function (r) {\n      if (!r.ok) throw new Error(\"HTTP \" + r.status);\n      var q = [\"client_id=\" + encodeURIComponent(client),\n               \"response_type=code\",\n               \"scope=\" + encodeURIComponent(SCOPE),\n               \"redirect_uri=\" + encodeURIComponent(REDIRECT),\n               \"state=\" + encodeURIComponent(state),\n               \"code_challenge=\" + ch,\n               \"code_challenge_method=S256\"];\n      flow(1);\n      setBusy(true, \"正在打开手机号验证…\");\n      $(\"goHint\").textContent = \"验证完成后会自动返回并保存账号，请勿复制任何令牌。\";\n      location.href = AUTH_EP + \"?\" + q.join(\"&\");\n    });\n  }).catch(function () {\n    TX.clear();\n    setBusy(false);\n    flow(0);\n    $(\"goHint\").innerHTML = '<span class=\"err\">无法连接本机 Loon 登录服务。请确认插件已更新、MITM 已开启并信任证书。</span>';\n  });\n};\n\n/* ---------- ② 粘贴 + 换取 ---------- */\n$(\"paste\").onclick = function () {\n  if (navigator.clipboard && navigator.clipboard.readText) {\n    navigator.clipboard.readText().then(function (t) { $(\"cb\").value = t; }).catch(function () {\n      say($(\"exOut\"), \"dim\", \"读不到剪贴板：长按输入框手动粘贴即可。\");\n    });\n  } else say($(\"exOut\"), \"dim\", \"这台设备不支持读剪贴板：长按输入框手动粘贴。\");\n};\n\nfunction safeDecode(s) {\n  try { return decodeURIComponent(String(s || \"\").replace(/\\+/g, \"%20\")); } catch (e) { return \"\"; }\n}\nfunction parseCode(text) {\n  text = String(text || \"\").trim();\n  if (!text) return { code: \"\", state: \"\", verifier: \"\", validUrl: false };\n  var validUrl = false;\n  try {\n    var u = new URL(text);\n    validUrl = u.protocol === \"https:\" && u.hostname === \"www.codebuddy.cn\" &&\n      u.pathname === \"/auth/realms/copilot/account/\";\n  } catch (e) {}\n  var m = text.match(/[?&#]code=([^&#\\s]+)/) || text.match(/^code=([^&#\\s]+)/);\n  var s = text.match(/[?&#]state=([^&#\\s]+)/);\n  var st = s ? safeDecode(s[1]) : \"\";\n  return { code: m ? safeDecode(m[1]) : \"\", state: st, validUrl: validUrl };\n}\n\nfunction exchange(body) {\n  return fetch(TOKEN_EP, {\n    method: \"POST\",\n    headers: { \"Content-Type\": \"application/x-www-form-urlencoded\", \"Accept\": \"application/json\" },\n    body: new URLSearchParams(body).toString()\n  }).then(function (r) {\n    return r.text().then(function (t) {\n      var j = {};\n      try { j = JSON.parse(t); } catch (e) { j = { error: \"bad_json\", error_description: t.slice(0, 200) }; }\n      if (!r.ok) throw j;\n      return j;\n    });\n  });\n}\n\nfunction explain(err) {\n  var e = String((err && err.error) || \"\"), d = String((err && err.error_description) || err || \"\");\n  if (e === \"invalid_grant\") {\n    if (/Code not valid|code/i.test(d)) return \"这条 code 已经用过或超过有效期（约 1 分钟）。重新点第 ① 步登录，拿到新的回调地址再粘一次。\";\n    if (/refresh/i.test(d)) return \"refresh_token 无效或已被换掉（每次续期旧的会作废，别用旧的那份）。\";\n    return d || \"授权被拒绝。\";\n  }\n  if (e === \"unauthorized_client\") return \"这个 client_id 不接受当前授权方式：可能是 client 需要密钥，或授权方式被关掉了。改用 account-console 再试。\";\n  if (e === \"invalid_client\") return \"client_id 不对（这个 client 在 codebuddy 上不存在）。\";\n  if (e === \"invalid_request\") return \"请求参数不全：\" + d;\n  return (e ? e + \"：\" : \"\") + (d || \"未知错误\");\n}\n\nfunction showTokens(tok, client) {\n  var pl = jwt(tok.access_token || \"\");\n  var uid = pl.sub || \"\";\n  var nick = pl.nickname || pl.preferred_username || pl.name || \"账号\";\n  var rec = {\n    nickname: nick,\n    access_token: tok.access_token || \"\",\n    uid: uid,\n    expiresAt: pl.exp ? pl.exp * 1000 : 0,\n    domain: \"www.codebuddy.cn\",\n    client: client\n  };\n  if (tok.refresh_token) rec.refresh_token = tok.refresh_token;\n  var pool = JSON.stringify([rec]);\n\n  $(\"info\").innerHTML =\n    '<p class=\"kv\"><b>昵称：</b>' + esc(nick) + \"</p>\" +\n    '<p class=\"kv\"><b>uid：</b><code>' + esc(uid) + \"</code></p>\" +\n    '<p class=\"kv\"><b>access_token 有效至：</b>' + esc(fmt(pl.exp)) + \"</p>\" +\n    '<p class=\"kv\"><b>refresh_token：</b>' +\n      (tok.refresh_token ? '<span class=\"ok\">有</span>（' + tok.refresh_token.length + \" 字符）\" : '<span class=\"warn\">无</span>（登录时没带 offline_access，过期就得重登）') +\n    \"</p>\" +\n    '<p class=\"kv\"><b>client：</b><code>' + esc(client) + \"</code>（决定以后能不能续期）</p>\";\n  $(\"pool\").value = pool;\n  $(\"outCard\").style.display = \"block\";\n  if (tok.refresh_token) LS.set(\"refresh_token\", tok.refresh_token);\n  LS.set(\"nickname\", nick);\n  LS.set(\"client\", client);\n  renderSession();\n}\n\n$(\"ex\").onclick = function () {\n  var p = parseCode($(\"cb\").value);\n  if (!p.validUrl) { say($(\"exOut\"), \"err\", \"回调地址不是预期的 CodeBuddy HTTPS 地址，请复制完整地址栏 URL。\"); return; }\n  if (!p.code) { say($(\"exOut\"), \"err\", \"没找到 code，把登录后那个完整的回调网址整段粘进来。\"); return; }\n  var expectedState = TX.get(\"state\");\n  var localVerifier = TX.get(\"verifier\");\n  if (!expectedState || p.state !== expectedState || !localVerifier) {\n    say($(\"exOut\"), \"err\", \"state 与当前登录事务不匹配或已失效。请在本页重新点一次「用手机号登录」。\");\n    return;\n  }\n  var client = TX.get(\"client\") || LS.get(\"client\") || $(\"client\").value || \"account-console\";\n  var body = { grant_type: \"authorization_code\", client_id: client, code: p.code, redirect_uri: REDIRECT };\n  var v = localVerifier;\n  body.code_verifier = v;\n  say($(\"exOut\"), \"dim\", \"正在换取令牌…\");\n  exchange(body).then(function (tok) {\n    TX.clear();\n    say($(\"exOut\"), \"ok\", \"换到了 ✓\");\n    showTokens(tok, client);\n  }).catch(function (err) {\n    TX.clear();\n    var t = String((err && err.message) || err);\n    if (/failed to fetch|load failed|networkerror|network request failed|typeerror/i.test(t)) {\n      say($(\"exOut\"), \"warn\",\n        \"浏览器把这次请求拦住了（跨域）：CodeBuddy 的令牌接口不给别的网站发跨域许可，所以这一页换不了令牌 —— 不是地址的问题。<br>\" +\n        \"改用手机上的 <b>BoxJS</b>：把上面这条 URL 粘进 WorkBuddy 应用里的「<b>登录回调地址</b>」并保存，\" +\n        \"再点「立即签到一轮（手动运行）」，由脚本在手机本地把 code 换成令牌（这条路同样不需要 MITM）。\");\n    } else {\n      say($(\"exOut\"), \"err\", esc(explain(err)));\n    }\n  });\n};\n\n$(\"copyPool\").onclick = function () {\n  var t = $(\"pool\").value;\n  function clearSensitive() {\n    LS.del(\"refresh_token\"); LS.del(\"nickname\"); LS.del(\"client\");\n    $(\"rt\").value = \"\";\n    renderSession();\n  }\n  if (navigator.clipboard && navigator.clipboard.writeText) {\n    navigator.clipboard.writeText(t).then(function () {\n      clearSensitive();\n      say($(\"verifyOut\"), \"ok\", \"已复制 ✓ 页面内保存的续期令牌已清除。\");\n    }, function () { $(\"pool\").select(); say($(\"verifyOut\"), \"dim\", \"自动复制失败，已全选，长按复制。\"); });\n  } else { $(\"pool\").select(); say($(\"verifyOut\"), \"dim\", \"已全选，长按复制。\"); }\n};\n\n$(\"verify\").onclick = function () {\n  var tok = (JSON.parse($(\"pool\").value || \"[{}]\")[0] || {}).access_token;\n  if (!tok) return;\n  var pl = jwt(tok);\n  say($(\"verifyOut\"), \"dim\", \"正在问签到接口…\");\n  fetch(API_BASE + \"/v2/billing/meter/checkin-activity-status\", {\n    method: \"POST\",\n    headers: { \"Content-Type\": \"application/json\", \"Authorization\": \"Bearer \" + tok, \"X-User-Id\": pl.sub || \"\" },\n    body: \"{}\"\n  }).then(function (r) { return r.text(); }).then(function (t) {\n    if (/today_checked_in|\"code\":0/.test(t)) say($(\"verifyOut\"), \"ok\", \"令牌可用 ✓ 签到接口认它（该接口返回 OK）。\");\n    else say($(\"verifyOut\"), \"warn\", \"接口回话：\" + esc(t.slice(0, 180)));\n  }).catch(function () {\n    say($(\"verifyOut\"), \"dim\", \"浏览器跨域拦住了，没法在这一页验证。装好 Loon 插件后走第 ⑤ 步会自动验证。\");\n  });\n};\n\n/* ---------- ④ 续期 ---------- */\nfunction renderSession() {\n  var rt = LS.get(\"refresh_token\"), nick = LS.get(\"nickname\"), client = LS.get(\"client\");\n  if (rt) $(\"sess\").innerHTML = '本机记住了 <b>' + esc(nick || \"账号\") + \"</b> 的 refresh_token（client <code>\" +\n      esc(client || \"?\") + \"</code>，共 \" + rt.length + \" 字符）。access_token 过期了点下面按钮就能换新的。\";\n  else $(\"sess\").textContent = \"还没有登录记录（或上次登录没拿到 refresh_token）。\";\n}\n$(\"refresh\").onclick = function () {\n  var rt = ($(\"rt\").value || \"\").trim() || LS.get(\"refresh_token\");\n  if (!rt) { say($(\"rfOut\"), \"err\", \"没有 refresh_token：先做第 ① ② 步登录，或把它粘进上面的框。\"); return; }\n  var client = LS.get(\"client\") || $(\"client\").value || \"account-console\";\n  say($(\"rfOut\"), \"dim\", \"正在续期…\");\n  exchange({ grant_type: \"refresh_token\", client_id: client, refresh_token: rt, scope: SCOPE })\n    .then(function (tok) {\n      say($(\"rfOut\"), \"ok\", \"续期成功 ✓（旧的 refresh_token 已作废，下面这份是新的）\");\n      showTokens(tok, client);\n    }).catch(function (err) { say($(\"rfOut\"), \"err\", esc(explain(err))); });\n};\n\n/* ---------- 回调横幅：Loon 换完令牌后带着 ?ok / ?warn / ?err 跳回本页 ---------- */\nfunction banner() {\n  var q = new URLSearchParams(location.search);\n  var el = $(\"banner\"), html = \"\";\n  var name = q.get(\"name\") || \"账号\";\n  var msg = q.get(\"msg\") || \"\";\n  var again = '<button class=\"btn sec\" onclick=\"goAgain()\">连接另一个账号</button>';\n  var toBox = '<a class=\"btn sec\" href=\"https://boxjs.com\" target=\"_blank\" rel=\"noreferrer\" style=\"color:#fff\">查看 BoxJS</a>';\n  if (q.get(\"ok\")) {\n    flow(3);\n    $(\"loginCard\").style.display = \"none\";\n    html = '<div class=\"card\" style=\"border-color:var(--ok);text-align:center\">' +\n      '<div style=\"font-size:42px;line-height:1\">✓</div>' +\n      '<h2 class=\"ok\" style=\"font-size:21px;margin-top:10px\">全部配置完成</h2>' +\n      '<p><b>' + esc(name) + '</b> 已连接，令牌验证通过并写入 BoxJS 账号池。</p>' +\n      '<p class=\"dim\">自动签到与令牌续期已经启用，之后无需再登录或复制任何内容。</p>' +\n      '<div class=\"row\">' + toBox + again + '</div></div>';\n  } else if (q.get(\"warn\")) {\n    flow(3);\n    html = '<div class=\"card\" style=\"border-color:var(--warn)\">' +\n      '<h2 class=\"warn\">令牌已自动保存，需要检查账号</h2>' +\n      '<p><b>' + esc(name) + '</b> 的令牌已经写进账号池，但签到接口回报：</p>' +\n      (msg ? '<p class=\"dim\">' + esc(msg) + '</p>' : '') +\n      '<p class=\"dim\">先在 BoxJS 里手动跑一轮看看结果；确实不行就把这条从账号池删掉，继续用电脑版导出的令牌。</p>' +\n      '<div class=\"row\">' + toBox + again + '</div></div>';\n  } else if (q.get(\"err\")) {\n    flow(0);\n    setBusy(false, \"重新安全登录\");\n    html = '<div class=\"card\" style=\"border-color:var(--err)\">' +\n      '<h2 class=\"err\">登录没有完成</h2>' +\n      '<p>' + esc(msg || \"换令牌失败\") + '</p>' +\n      '<p class=\"dim\">点击下方按钮重新开始；系统会建立新的安全事务并自动完成后续步骤。</p>' +\n      '<div class=\"row\">' + again + '</div></div>';\n  }\n  if (html) {\n    el.innerHTML = html;\n    window.scrollTo(0, 0);\n    try { history.replaceState({}, \"\", location.pathname); } catch (e) {}\n  }\n}\nfunction goAgain() { location.href = location.pathname; }\n\n/* 首次渲染 */\n(function srcNote() {\n  var el = $(\"src\");\n  if (!el) return;\n  el.textContent = \"WorkBuddy 本机安全登录\";\n})();\nbanner();\nrenderSession();\nwindow.addEventListener(\"paste\", function () {\n  setTimeout(function () {\n    if ($(\"cb\").value && !$(\"exOut\").innerHTML) say($(\"exOut\"), \"dim\", \"粘好了，点「换取令牌」。\");\n  }, 60);\n});\n</script>\n</body>\n</html>\n";
/* ==== PAGE_HTML:END ==== */

(function main() {
  if (argument() === "page") return servePage();
  if (argument() === "login-session") return serveLoginSession();

  // 「待换取的回调地址」：用户在 BoxJS 里粘了登录后的那条 URL 时，任何一次运行都先把它换掉。
  // 这条路不需要 MITM —— 换令牌是脚本自己发出去的 HTTPS 请求，不受浏览器跨域限制。
  var pendingLogin = String(store("WorkBuddy_LoginCallback", "") || "").replace(/^\s+|\s+$/g, "");
  if (pendingLogin && argument() !== "panel" && argument() !== "login") {
    if (/^https:\/\/www\.codebuddy\.cn\/auth\/realms\/copilot\/account\//i.test(pendingLogin)) {
      log("⇢ 发现待换取的回调地址（" + pendingLogin.length + " 字符），先完成登录");
      return loginCallback(pendingLogin);
    }
    log("! BoxJS 的「登录回调地址」不是一条 http(s) 地址，已忽略（本轮照常签到）");
  }

  if (argument() === "login") return loginCallback();

  if (argument() === "panel") return panel();

  if (typeof $request !== "undefined" && $request && $request.headers) return captureToken();

  GLOBAL_BUDGET = asInt(store("WorkBuddy_Budget", "540"), 540);
  if (GLOBAL_BUDGET < 60) GLOBAL_BUDGET = 540;
  RUN_T0 = Date.now();

  var loaded = loadAccounts();
  var poolURL = store("WorkBuddy_AccountsURL", "");

  // 配了账号池 URL 就以它为准（本地账号池只当作拉取失败时的兜底），
  // 这样电脑上重新导出后只需覆盖托管的那份文件，手机端不用再动。
  if (poolURL) {
    return loadAccountsFromURL(poolURL, function (info) {
      if (info.list.length) return begin(info.list, info.skipped || []);
      var detail = info.skipped && info.skipped.length ? info.skipped.map(function (s) { return s.reason; }).join("；") : "拉取失败";
      var reason = detail + (loaded.list.length ? "，改用本地缓存" : "，且本地没有账号池");
      begin(loaded.list, loaded.skipped.concat([{ name: "账号池 URL", reason: reason }]));
    });
  }
  begin(loaded.list, loaded.skipped);
})();

function begin(list, skipped) {
  ACCOUNTS = list;
  SKIPPED = skipped || [];
  log("══ WorkBuddy 启动 ══ argument=" + (argument() || "(空)") +
      "，账号池原始长度=" + store("WorkBuddy_Accounts", "").length +
      "，解析出 " + list.length + " 个账号");
  for (var si = 0; si < SKIPPED.length; si++) log("⤫ 跳过 " + SKIPPED[si].name + "：" + SKIPPED[si].reason);

  // 先续期（手机登录页换来的令牌能自己续），再跑签到
  refreshPass(function () {
    var alive = [];
    for (var ai = 0; ai < ACCOUNTS.length; ai++) {
      if (ACCOUNTS[ai].renewFailed) {
        SKIPPED.push({ name: ACCOUNTS[ai].name, reason: "自动续期失败（" + ACCOUNTS[ai].renewFailed + "），请重新登录：" + LOGIN_URL });
        continue;
      }
      if (!ACCOUNTS[ai].token) { SKIPPED.push({ name: ACCOUNTS[ai].name, reason: "没有可用令牌" }); continue; }
      alive.push(ACCOUNTS[ai]);
    }
    ACCOUNTS = alive;
    proceed();
  });

  function proceed() {
    if (!ACCOUNTS.length) {
      var why = SKIPPED.length
        ? SKIPPED.map(function (s) { return s.name + "：" + s.reason; }).join("；")
        : "未找到 accessToken，请先在 BoxJS 里填写 WorkBuddy_Token 或 WorkBuddy_Accounts";
      // 全是「令牌已过期」时，报「账号已失效」而不是含糊的「未配置」——这是需要重新登录，不是没填
      var expiredCnt = 0, renewCnt = 0;
      for (var ei = 0; ei < SKIPPED.length; ei++) {
        var rsn = String(SKIPPED[ei].reason);
        if (rsn.indexOf("过期") >= 0) expiredCnt++;
        if (rsn.indexOf("续期失败") >= 0) renewCnt++;
      }
      if ((expiredCnt || renewCnt) && expiredCnt + renewCnt === SKIPPED.length) {
        notify("WorkBuddy 账号已失效", "令牌过期且续期失败，需重新登录", why);
        return finish("AUTH_ERROR", "账号令牌全部已过期（或续期失败）—— 请到手机登录页重新登录：" + LOGIN_URL);
      }
      notify("WorkBuddy 未配置", "没有可用账号", why);
      return finish("NO_AUTH", why);
    }

    // 整个 cron 必须跑完所有账号，故每个账号分到的预算 = 总预算 / 账号数
    BUDGET = Math.max(60, Math.min(240, Math.floor(GLOBAL_BUDGET / ACCOUNTS.length)));
    accIndex = 0;
    RESULTS = [];
    nextAccount();
  }
}
