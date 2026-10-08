/* WorkBuddy 登录页内联（argument=page）mock 测试
 *
 * 为什么测这个：手机登录页默认由 Loon 直接提供 —— 插件的「WorkBuddy登录页」规则匹配
 * https://www.codebuddy.cn/wb-login，脚本必须把 login.html 原封不动地当响应吐出来。
 * 这里保证三件事：
 *   1. PAGE_HTML 和磁盘上的 login.html 完全一致（改了页面忘了跑 build-page.py 会当场报错）
 *   2. 真的回了 200 + text/html，body 就是那份 HTML（不是被转义过的字符串）
 *   3. 页面里的关键元素都在（全自动主流程、结果横幅、PKCE 安全事务、故障恢复入口）
 *
 * 跑法：node tests/workbuddy-page.test.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const BASE = path.resolve(__dirname, "..");
const SRC = path.join(BASE, "workbuddy.js");
const HTML = fs.readFileSync(path.join(BASE, "login.html"), "utf8");
const code = fs.readFileSync(SRC, "utf8");

let fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log("  PASS " + name);
  else { fails++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}

console.log("=== 场景：argument=page 由 Loon 直接提供登录页 ===");
const logs = [];
const doneArgs = [];
const sandbox = {
  console: { log: function () { logs.push(Array.prototype.slice.call(arguments).join(" ")); } },
  $persistentStore: { read: () => null, write: () => {} },
  $notify: () => {},
  $done: (a) => { doneArgs.push(a); },
  $argument: "page",
  // http-request 环境下 $request 一定存在；page 分支必须抢在 captureToken 前面
  $request: { url: "https://www.codebuddy.cn/wb-login?ok=1", method: "GET", headers: {} },
  $httpClient: {
    get: () => { throw new Error("page 模式不应该发任何请求"); },
    post: () => { throw new Error("page 模式不应该发任何请求"); }
  }
};
vm.runInContext(code, vm.createContext(sandbox));

const arg = doneArgs[doneArgs.length - 1];
const resp = arg && arg.response;
ok("调用了 $done 且带 response", !!resp, arg);
ok("状态码 200", !!resp && resp.status === 200, resp && resp.status);
ok("Content-Type 是 text/html（浏览器才会渲染而不是显示源码）",
  !!resp && /text\/html/.test(resp.headers["Content-Type"] || ""), resp && resp.headers);
ok("禁止缓存（改完页面立刻生效，不用等 CDN）",
  !!resp && /no-store/.test(resp.headers["Cache-Control"] || ""), resp && resp.headers);
ok("body 与 login.html 字节级一致（没被转义/截断）", !!resp && resp.body === HTML,
  { got: resp && resp.body && resp.body.length, want: HTML.length });
ok("body 是完整 HTML 而不是 JSON 字符串", !!resp && /^<!DOCTYPE html>/.test(resp.body), resp && resp.body.slice(0, 30));
ok("只 $done 一次", doneArgs.length === 1, doneArgs.length);
ok("日志里写了 HTML 字节数", logs.some((l) => /输出登录页：HTML \d+ 字节/.test(l)), logs);

console.log("\n=== 页面关键元素 ===");
ok("有结果横幅容器", HTML.indexOf('id="banner"') > 0);
ok("有成功、警告、失败三种回跳文案",
  HTML.indexOf("全部配置完成") > 0 && HTML.indexOf("令牌已自动保存") > 0 && HTML.indexOf("登录没有完成") > 0);
ok("主流程明确为全自动且无需复制",
  HTML.indexOf("后续获取令牌、校验账号、写入账号池和启用自动续期全部自动完成") > 0 &&
  HTML.indexOf("无需复制地址、令牌或打开 BoxJS") > 0);
ok("手工粘贴只保留在故障恢复折叠区",
  HTML.indexOf('<details class="card recovery">') > 0 && HTML.indexOf("登录没有自动返回？打开故障恢复") > 0);
ok("PKCE 强制开启（account-console 服务端要求，页面已无关闭选项）",
  HTML.indexOf('"code_challenge_method=S256"') > 0 &&
  HTML.indexOf('"code_challenge=" + ch') > 0 &&
  HTML.indexOf("<option value=\"0\" selected>关闭") < 0);
ok("PKCE verifier 不进入回调 URL，并通过一次性登录事务保存",
  HTML.indexOf('var state = rand(32)') > 0 && HTML.indexOf('TX.set("verifier", verifier)') > 0 &&
  HTML.indexOf('state = rand(16) + "~" + verifier') < 0);
ok("故障恢复入口默认折叠且不干扰一键登录", HTML.indexOf("登录没有自动返回？打开故障恢复") > 0);
ok("refresh token 不写入 localStorage",
  HTML.indexOf('localStorage.setItem("wb_" + k, v)') < 0 && HTML.indexOf("var MEM = {}") > 0);
ok("仍指向正确的 realm / 公开客户端",
  HTML.indexOf("realms/copilot") > 0 && HTML.indexOf("account-console") > 0);

console.log("\n=== 脚本侧接线 ===");
ok("脚本里有 servePage 分支", code.indexOf('if (argument() === "page") return servePage();') > 0);
ok("脚本里有一次性登录事务分支", code.indexOf('if (argument() === "login-session") return serveLoginSession();') > 0);
ok("page 分支在 captureToken 之前（否则会被抓令牌逻辑抢走）",
  code.indexOf('if (argument() === "page") return servePage();') < code.indexOf("return captureToken();"));
ok("登录页地址默认走 codebuddy 域名（不依赖 GitHub Pages）",
  code.indexOf('var LOGIN_URL = PAGE_URL;') > 0 && code.indexOf('var PAGE_URL = "https://www.codebuddy.cn/wb-login";') > 0);

console.log("");
if (fails) { console.log("✗ " + fails + " 条断言失败"); process.exit(1); }
console.log("✓ 全部断言通过");
