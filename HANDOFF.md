# WorkBuddy Loon 项目交接文档

## 1. 项目概况

- 仓库：`xlzs001/workbuddy-loon`
- 当前交接版本：`v1.2.0`
- 运行端：Loon / Surge / QuantumultX / BoxJS
- 核心脚本：`workbuddy.js`
- 主要目标：在手机端自动完成 WorkBuddy 登录取令牌、每日签到、成长中心任务、多账号运行和令牌续期。

### v1.2.0 交付状态

- 手机登录页已改为“一键安全登录”主流程。
- 登录后自动换取、验证并保存令牌，无需复制地址或账号池 JSON。
- 手工粘贴回调仅保留为折叠式故障恢复。
- `WorkBuddy.plugin`、`boxjs.json` 和文档统一固定到 `v1.2.0`。
- 四组 Node mock 测试、JavaScript 语法检查、Python 编译和页面内联一致性检查均已通过。

## 2. 目录与职责

| 文件 | 职责 | 修改注意事项 |
|---|---|---|
| `workbuddy.js` | 主业务、宿主兼容、多账号、签到、成长中心、OAuth 回调、页面响应 | `PAGE_HTML` 区域由脚本生成，不要手改 |
| `login.html` | 手机登录页面源码 | 修改后必须运行 `python build-page.py` |
| `build-page.py` | 将 `login.html` 内联到 `workbuddy.js` | CI/发布前运行 `--check` |
| `WorkBuddy.plugin` | Loon 规则、MITM、定时任务、面板入口 | 发布 URL 必须固定到不可变标签 |
| `boxjs.json` | BoxJS 应用定义、设置项和运行入口 | JSON 必须保持合法；版本 URL 与插件同步 |
| `accounts-slim.py` | 多账号导出文件精简、安全输出 | 默认不得向 stdout 泄露完整令牌 |
| `export-token.py` | 兼容桌面端凭据导出 | 桌面令牌通常不能自动续期 |
| `tests/workbuddy-multi.test.js` | 多账号和业务流程 mock | 假令牌，不联网 |
| `tests/workbuddy-login.test.js` | 登录、续期和回调 mock | 覆盖一次性 OAuth 事务 |
| `tests/workbuddy-page.test.js` | 登录页内联和关键 UI 契约 | 页面文案/结构调整时同步更新 |
| `tests/workbuddy-regression.test.js` | 已修复缺陷的防回归测试 | 新缺陷修复应优先追加到这里 |
| `deploy-github.sh` | 发布和标签脚本 | 只允许干净工作树发布 |

## 3. 运行架构

同一份 `workbuddy.js` 根据宿主参数承担不同角色：

| 调用方式 | 参数 | 行为 |
|---|---|---|
| 登录页 | `page` | 返回内联的 `login.html` |
| 建立登录事务 | `login-session` | 保存 10 分钟有效的 `{state, verifier, client}` |
| OAuth 回调 | `login` | 校验回调与事务，换令牌、验账号、写账号池并 302 回结果页 |
| 自动任务 | `auto` / `poll` | 逐账号执行签到和成长中心 |
| 手动任务 | `auto` | 与自动任务相同，由 Loon 手工入口触发 |
| 面板 | `panel` | 返回最近一次结果摘要 |
| 请求捕获 | 无固定参数 | 从 `copilot.tencent.com/v2/` 请求中刷新账号池令牌 |

## 4. 全自动登录链路

1. 用户打开 `https://www.codebuddy.cn/wb-login`。
2. Loon 的 `argument=page` 规则返回内联登录页。
3. 用户点击“开始安全登录”。
4. 页面生成随机 `state`、PKCE verifier 和 S256 challenge。
5. 页面 POST `/wb-login/session`；Loon 用 `argument=login-session` 保存一次性事务。
6. 浏览器进入 CodeBuddy Keycloak，用户完成手机号验证。
7. Keycloak 回调 `/auth/realms/copilot/account/`；Loon 用 `argument=login` 接管。
8. 脚本严格校验 HTTPS、主机、路径、state 和 10 分钟有效期。
9. 脚本消费事务，用 authorization code + verifier 换令牌。
10. 令牌写入 `WorkBuddy_Accounts`，随后调用签到状态接口验证。
11. 浏览器 302 返回 `/wb-login?ok=...`、`?warn=...` 或 `?err=...`。
12. 页面展示结果；成功后不要求用户进行任何复制操作。

### 安全约束

- PKCE verifier 不进入回调 URL。
- OAuth 事务使用后立即清空；过期、state 不匹配或重放均拒绝。
- 登录页不把 access token / refresh token 写入 `localStorage`。
- 只接受预期的 CodeBuddy HTTPS 回调地址。
- 账号池 URL 只允许 HTTPS，响应最大 1 MiB，最多 100 个账号。
- 生产插件引用不可变版本标签，不跟踪 `main`。

## 5. BoxJS 核心存储键

| 键 | 作用 |
|---|---|
| `WorkBuddy_Accounts` | 多账号池，推荐配置入口 |
| `WorkBuddy_AccountsURL` | 可选的远程 HTTPS 账号池 |
| `WorkBuddy_LoginTransaction` | 10 分钟有效的一次性登录事务 |
| `WorkBuddy_LoginCallback` | 仅故障恢复时使用的完整回调 URL |
| `WorkBuddy_LoginClient` | Keycloak 公开客户端，默认 `account-console` |
| `WorkBuddy_Budget` | 整轮运行预算，默认 540 秒 |
| `WorkBuddy_EnableGrowth` | 是否执行成长中心 |
| `WorkBuddy_EnableBuddyOpen` | 是否开启 Buddy 能量盲盒 |
| `WorkBuddy_Notify` | 是否发送通知 |
| `WorkBuddy_LogEmpty` | 空跑时是否记录/通知 |
| `WorkBuddy_LastJSON` | 最近一次结构化执行结果 |
| `WorkBuddy_LastReport` | 最近一次文本报告 |

真实令牌禁止提交到 Git。`.gitignore` 已覆盖常见账号文件、日志、Python 缓存和依赖目录。

## 6. 本地开发与测试

### 修改登录页

```bash
python build-page.py
python build-page.py --check
```

`build-page.py` 会把 `login.html` 写入 `workbuddy.js` 的 `PAGE_HTML` 区域。提交前必须保证 `--check` 通过。

### 完整测试

```bash
node tests/workbuddy-multi.test.js
node tests/workbuddy-login.test.js
node tests/workbuddy-page.test.js
node tests/workbuddy-regression.test.js
node --check workbuddy.js
python -m py_compile accounts-slim.py export-token.py build-page.py
```

### 最小发布检查

1. 所有测试通过。
2. `python build-page.py --check` 通过。
3. `boxjs.json` 能被 JSON 解析器读取。
4. `git diff --check` 无错误。
5. 搜索仓库确认没有真实 token、PAT、私钥和账号导出文件。
6. `WorkBuddy.plugin`、`boxjs.json`、README、`deploy-github.sh` 使用同一版本号。

## 7. 发布流程

版本号必须使用新的不可变标签，禁止移动旧标签。

```bash
python build-page.py
node tests/workbuddy-multi.test.js
node tests/workbuddy-login.test.js
node tests/workbuddy-page.test.js
node tests/workbuddy-regression.test.js
git add -A
git commit -m "feat: automate mobile login flow"
git tag v1.2.0
git push origin main
git push origin v1.2.0
```

发布后检查：

- `main` 指向新提交；
- `v1.2.0` 指向同一提交；
- 标签下的 `workbuddy.js`、`WorkBuddy.plugin`、`boxjs.json` 可访问；
- Loon 更新插件后能打开登录页并建立 `/wb-login/session` 事务。

## 8. 故障排查

| 现象 | 检查项 |
|---|---|
| 登录页打不开 | 插件是否更新；MITM 是否开启；证书是否信任；hostname 是否含 `www.codebuddy.cn` |
| 点击登录后提示无法连接本机服务 | `/wb-login/session` 规则未命中或 `v1.2.0` 脚本不可达 |
| 登录后出现 IP not allowed JSON | OAuth 回调规则未命中；检查 `WorkBuddy手机登录` 规则和 MITM |
| state 不匹配/事务过期 | 回到登录页重新开始；不要复用旧回调地址 |
| `invalid_grant: Code not valid` | code 已使用或超过有效期，重新登录 |
| 登录成功但验证失败 | 在 BoxJS 手动跑一轮，检查账号权限、风控、企业账号限制 |
| 自动续期失败 | 确认令牌来自手机登录的公开客户端；桌面 `console` 客户端令牌不能由脚本续期 |
| 账号池 URL 失败 | 必须是可直接访问的 HTTPS JSON；检查响应大小和结构 |

## 9. 已知边界

- 登录自动化依赖 Loon MITM；没有插件或未信任证书时不能接管 OAuth 回调。
- GitHub Pages 只是备用页面，安全事务和回调处理仍依赖最新版插件。
- 手工回调粘贴仅是故障恢复，不应作为默认用户路径。
- CodeBuddy 接口和 Keycloak 配置若变更，端点、client、scope 或返回结构可能需要同步调整。
- 项目当前未声明开源许可证；如计划对外推广，应由仓库所有者明确选择并添加许可证。

## 10. 接手检查清单

- [ ] 能说明 `page`、`login-session`、`login` 三个入口的职责。
- [ ] 修改页面后会运行 `build-page.py`。
- [ ] 新缺陷有对应回归测试。
- [ ] 发布时同步更新四处版本引用。
- [ ] 不移动已发布标签，不让生产配置指向 `main`。
- [ ] 不把真实账号池、token、PAT 或日志提交到仓库。
- [ ] 发布后用手机验证完整登录回跳和一次自动签到。
