/*******************************************
 * WorkBuddy 自动签到 · Loon / Surge / QuantumultX / BoxJS
 *
 * 由 88lin/workbuddy-auto-signin 的 signin.py 移植：
 *   签到      → /v2/billing/meter/checkin-activity-status + /daily-checkin
 *   成长中心  → /v2/activity/growth/**（旅行礼物、派 Buddy、任务、补登、
 *               连登兑换、盲盒、Buddy 能量盲盒）
 *
 * 三种被调用方式（同一份脚本）：
 *   1. cron        → 自动签到 / 成长中心轮询
 *   2. http-request → 抓取手机端请求里的 Authorization 自动保鲜令牌
 *   3. panel       → 读取上次结果做卡片展示
 *******************************************/

var HOST = "https://copilot.tencent.com";
var GROWTH = HOST + "/v2/activity/growth";
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
  try { if (typeof $persistentStore !== "undefined" && $persistentStore) $persistentStore.write(String(value), key); return; } catch (e) {}
  try { if (typeof $prefs !== "undefined" && $prefs && $prefs.setValueForKey) $prefs.setValueForKey(String(value), key); } catch (e) {}
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
    if (err) return cb(-1, String(err));
    var code = 0;
    try { code = asInt((resp && (resp.status || resp.statusCode)) || 0, 0); } catch (e) {}
    cb(code, String(data === null || data === undefined ? "" : data));
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
  "AUTH_ERROR": "令牌失效，需重新导出",
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
  parts.push("令牌已失效（HTTP " + code + "）—— 等同于密码错误，需要重新导出");
  finish("AUTH_ERROR", "令牌已失效（HTTP " + code + "）：等同于密码错误，请在电脑上重新导出令牌并更新 BoxJS 账号池");
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
      if (b2 === null || asInt(dig(b2, "code"), 0) === 10001 || msg.indexOf("已签") >= 0) {
        return alreadyReport(b2, "今日已签过（服务端判定已领取）", next);
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
        var res = dig(b2, "results");
        if (res && res.length) {
          for (var k = 0; k < res.length; k++) {
            if (res[k] && res[k].status === "error") {
              parts.push("接单失败（" + (res[k].task_code || "?") + "：" + (res[k].message || "") + "）");
              ctx.fail++;
            }
          }
        }
        if (c2 >= 200 && c2 < 300) ctx.ok++;
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
    expiresAt: asInt(o.expiresAt || o.expires_at, 0)
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
    if (expired(a)) { out.skipped.push({ name: a.name, reason: "令牌已过期（" + stamp(a.expiresAt) + "）" }); continue; }
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
function loadAccountsFromURL(url, cb) {
  fetchPlain(url, function (code, data) {
    if (code < 200 || code >= 300 || !data) {
      return cb({ list: [], skipped: [{ name: "账号 URL", reason: "拉取失败（" + httpLabel(code) + "）" }] });
    }
    var backup = store("WorkBuddy_Accounts", "");
    save("WorkBuddy_Accounts", data);
    var info = loadAccounts();
    if (!info.list.length && backup) save("WorkBuddy_Accounts", backup);   // 拉到的内容不可用则回滚
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
  if (soon.length) lines.push("⚠️ 令牌即将过期：" + soon.join("、") + " —— 请尽快在电脑上重新导出并更新账号池");
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

(function main() {
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
      var reason = loaded.list.length ? "拉取失败，改用本地缓存" : "拉取失败，且本地没有账号池";
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

  if (!ACCOUNTS.length) {
    var why = SKIPPED.length
      ? SKIPPED.map(function (s) { return s.name + "：" + s.reason; }).join("；")
      : "未找到 accessToken，请先在 BoxJS 里填写 WorkBuddy_Token 或 WorkBuddy_Accounts";
    // 全是「令牌已过期」时，报「账号已失效」而不是含糊的「未配置」——这是需要重新导出，不是没填
    var expiredCnt = 0;
    for (var ei = 0; ei < SKIPPED.length; ei++) {
      if (String(SKIPPED[ei].reason).indexOf("过期") >= 0) expiredCnt++;
    }
    if (expiredCnt && expiredCnt === SKIPPED.length) {
      notify("WorkBuddy 账号已失效", "令牌全部过期，需重新导出", why);
      return finish("AUTH_ERROR", "账号令牌全部已过期 —— 请在电脑上重新导出令牌并更新 BoxJS 账号池");
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
