# WorkBuddy 自动签到 → Loon / BoxJS 版

把 [88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin) 的签到 + 成长中心逻辑搬到手机上跑：
Loon 定时触发、BoxJS 存令牌看结果，不用开着电脑。

## 0. 先说清楚能不能直接部署

`signin.py` **不能**直接放进 BoxJS 或 Loon，原因有三条，都是硬性的：

| 依赖 | signin.py 需要 | BoxJS / Loon 提供 |
|---|---|---|
| Python 运行时 | Python 3 | 只有 JavaScriptCore，没有 Python |
| 凭据文件 | 读本机 `workbuddy-desktop.info` | 脚本跑在手机上，没有文件系统，更没有桌面端的凭据文件 |
| 加密凭据解密 | 起客户端原生子进程解密 `$wbEncrypted` | 手机上没装桌面端，无法解密 |

所以本项目的做法是**换一层壳，而不是搬运脚本**：

```
桌面端导出一次令牌 ──► BoxJS 保存 token / uid ──► Loon cron 跑 workbuddy.js（纯 JS 重写）──► 通知 + BoxJS 记录结果
```

接口、参数、幂等策略、补登规则、连登档位标识（`"7d"/"14d"/"28d"`）全部按 `signin.py` 1:1 移植，
端点是 `https://copilot.tencent.com`，请求头与桌面端一致（`Authorization: Bearer` + `X-User-Id`）。

## 1. 文件清单

| 文件 | 作用 |
|---|---|
| `workbuddy.js` | 主脚本，Loon / Surge / QuantumultX 通用。一个文件四种身份：整轮签到、抓令牌保鲜、卡片面板、**登录回调换令牌** |
| `login.html` | **手机登录页**（纯静态，手机浏览器直接开）：登录一次即可拿令牌并写进 BoxJS 账号池 |
| `WorkBuddy.plugin` | Loon 插件（两条 cron + MITM 抓令牌 + 可选 Panel） |
| `boxjs.json` | BoxJS 订阅，提供配置面板与 14 个存储键（含账号池），应用页上有「📱 手机登录」按钮 |
| `accounts-slim.py` | **多账号**：把切号工具导出的账号 JSON 压成一行、直接粘进 BoxJS |
| `export-token.py` | **单账号**：在电脑上导出令牌，复用 signin.py 自己的探测/解密逻辑 |
| `deploy-github.sh` | 一键部署：凭据对照扫描 → 建仓库 → 推送 → 验证 raw 地址 |
| `tests/workbuddy-multi.test.js` | Node mock 测试（假令牌、不联网），多账号/账号池 URL/兑换兜底/401·403/临期等 12 个场景 |
| `tests/workbuddy-login.test.js` | Node mock 测试：手机登录换令牌、自动续期、续期失败等 5 个场景 |

跑测试（需要 Node，与 Loon 无关；两个文件都应全绿）：

```bash
node tests/workbuddy-multi.test.js    # 12 个场景，✓ 全部断言通过
node tests/workbuddy-login.test.js    # 5 个场景，✓ 全部断言通过
```

## 2. 部署三步

### 第 1 步 · 拿令牌

三条路，**能碰手机就走 C**（不用电脑，而且只有它能自动续期）。

#### C. 手机登录（推荐，不用电脑）

手机浏览器打开：

```
https://cdn.jsdelivr.net/gh/xlzs001/workbuddy-loon@main/login.html
```

（或 BoxJS → 应用 → WorkBuddy 自动签到 → 页面上的「📱 手机登录 / 续期」按钮。）

点「用手机号登录」→ 走 CodeBuddy 官方登录页 → 登录完成后浏览器跳回一个
`https://www.codebuddy.cn/auth/realms/copilot/account/?...&code=xxxx` 地址。两种用法：

- **装了插件的 MITM（推荐）**：Loon 会在这一跳里把 `code` 换成令牌、验证可用，然后
  **自动写进 BoxJS 账号池**并弹通知「WorkBuddy 登录成功」，你什么都不用做。
  页面里把「PKCE」关掉（默认），否则要在 BoxJS 的 `WorkBuddy_LoginVerifier` 里补一次 verifier。
- **纯浏览器（不用 Loon）**：登录前把「PKCE」打开 → 跳回来后复制地址栏那一整条 URL，
  粘回登录页的第二步 → 页面里换出令牌 → 复制生成的账号池 JSON → 粘进 BoxJS 的「账号池」。

这样拿到的令牌带 `refresh_token`，**脚本每轮会自己续期**，基本一次登录管很久。

> 实测确认过的两件事：① 电脑端导出的令牌**本来就能**直接签到（`checkin-activity-status` 返回 200）；
> ② 但电脑端的令牌用的是机密客户端 `console`，**没法**被脚本续期（续期是客户端绑定的），到期只能重导。
> 所以：**不想再碰电脑就用 C，想要多账号批量就用 A**。

#### A. 多账号（切号工具，需要电脑）

#### A. 多账号（推荐）

如果你用切号工具管理多个账号（导出的文件长这样：顶层数组，元素带
`access_token` / `uid` / `nickname` / `profile_raw`），直接压缩一下就能用：

```bash
python3 accounts-slim.py wb-switch-accounts-2026-10-06.json
# → 一行 JSON 已复制到剪贴板（macOS pbcopy），终端只显示打码摘要与到期时间
```

它只保留 `nickname` / `access_token` / `uid` / `domain` / `enterpriseId` / `expiresAt` / `note`，
丢掉 `profile_raw`、`auth_raw` 这些几 KB 的无用字段（实测 19 KB → 4.6 KB，剩下的大头是 3 个 JWT 本身），
并默认剔除已过期、按 `uid` 去重。然后把结果粘进 BoxJS 的 **「账号池」** 字段即可。

#### B. 单账号

电脑上要有装好并登录过的 WorkBuddy 桌面端，以及 `workbuddy-auto-signin` 仓库：

```bash
git clone https://github.com/88lin/workbuddy-auto-signin.git
cd workbuddy-auto-signin
python3 /path/to/export-token.py .        # 输出一行 JSON
```

输出示例：

```json
{ "token": "eyJhb...", "uid": "1234567", "enterpriseId": "", "domain": "", "endpoint": "https://copilot.tencent.com" }
```

这条路径连新版 `$wbEncrypted` 加密凭据都能处理，因为它直接调用 `signin.py` 的
`find_auth_file()` / `load_session_retry()` / `resolve_session()` / `build_headers()`。
把 `token` / `uid` 填进 BoxJS 的单账号字段即可（不填账号池时脚本自动走这条路）。

不想跑 Python 也行（仅限旧版明文凭据）——直接读文件：

```bash
# macOS
jq -r '.auth.accessToken, .account.uid' \
  ~/Library/Application\ Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
# Windows PowerShell
Get-Content "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info" | ConvertFrom-Json | Select auth,account
```

### 第 2 步 · 把脚本托管出去

Loon 需要一个能匿名访问到的 URL，所以用**公开**仓库（本项目不含任何令牌，公开是安全的）。
本仓库已指向 `github.com/xlzs001/workbuddy-loon`。

**一键部署**（在仓库根目录跑）：

```bash
GH_TOKEN=github_pat_xxxx ./deploy-github.sh
#   1) 先拿切号工具导出的账号文件做「真实凭据对照扫描」，命中就直接中止
#   2) 用 PAT 通过 API 建仓库（已经是 422 就复用）
#   3) 推送，token 只在那一条命令里出现，推完立刻从 remote 抹掉
#   4) 逐个 curl raw 地址，确认 Loon 真能拉到
```

不想把 PAT 交给脚本也行，先自己 push，脚本只做检查与验证：

```bash
./deploy-github.sh          # 无 GH_TOKEN 时会提示你先在网页建好仓库，再走钥匙串 push
```

**手动部署**（等价的两条命令）：

```bash
cd workbuddy-loon
git remote add origin https://github.com/xlzs001/workbuddy-loon.git
git branch -M main && git push -u origin main
```

之后每次改脚本只要 `git add -A && git commit -m "update" && git push`。
嫌 raw.githubusercontent.com 慢可以用 jsDelivr 包一层（同步有延迟，插件地址不用改）：

```
https://cdn.jsdelivr.net/gh/xlzs001/workbuddy-loon@main/workbuddy.js
```

> 想换仓库：把 `WorkBuddy.plugin` 与 `boxjs.json` 里全部 `xlzs001/workbuddy-loon` 替换掉即可。

### 第 3 步 · 手机端安装

1. **安装 BoxJS**（没装过的话）：Loon → 配置 → 插件 → 添加
   `https://raw.githubusercontent.com/chavyleung/scripts/master/box/rewrite/boxjs.rewrite.loon.plugin`
2. **添加签到插件**：Loon → 配置 → 插件 → 添加 →
   `https://raw.githubusercontent.com/xlzs001/workbuddy-loon/main/WorkBuddy.plugin` → 打开开关
3. **添加 BoxJS 订阅**：打开 BoxJS 网页/App → 订阅 → 添加
   `https://raw.githubusercontent.com/xlzs001/workbuddy-loon/main/boxjs.json`
4. **填令牌**：BoxJS → 应用 → 「WorkBuddy 自动签到」 →
   多账号：粘贴到 **「账号池」**；单账号：填 `accessToken` 与 `uid`
   （`enterpriseId` / `domain` 仅企业账号需要）→ **点右下角蓝色浮动按钮保存**，
   再下拉刷新一次页面确认值还在（不保存 = 脚本读到的还是空的）
5. **首次验证**（两种手动入口，任选）：
   - **BoxJS 里**：应用页标题栏右侧的 ▶️ 圆形按钮（或页面里的「脚本 (1) → 立即签到一轮」），
     点一下就在 BoxJS 里跑一轮，执行日志会弹在一个 sheet 里
   - **Loon 里**：插件详情页 / 脚本列表 → **`WorkBuddy手动签到`** → 点一下立刻跑一轮
   两者都不用手动等 00:05；脚本打印的日志（启动 / 每个接口的 HTTP 码 / 汇总）是排错的主要手段

## 3. 多账号（账号池）

一个脚本跑多个账号：按顺序逐个跑，每个账号的表现单独记录，最后汇总成一条通知。

### 账号池格式

一个 JSON 数组，元素至少要有 `access_token` 和 `uid`：

```json
[
  { "nickname": "大号",   "access_token": "eyJ...", "uid": "aaaaaaaa-1111-...", "domain": "www.codebuddy.cn", "expiresAt": 1794541440000 },
  { "nickname": "小号",   "note": "小号", "access_token": "eyJ...", "uid": "bbbbbbbb-2222-...", "expiresAt": 1794541620000 },
  { "name": "第三个",     "token": "eyJ...", "uid": "cccccccc-3333-..." }
]
```

| 字段 | 说明 |
|---|---|
| `access_token` | 必填，也接受 `accessToken` / `token`；带 `Bearer ` 前缀会自动剥掉 |
| `uid` | 必填，作为 `X-User-Id` 发送 |
| `nickname` / `name` | 可选显示名，缺省为「账号 N」 |
| `note` | 可选备注；与显示名不同时会拼成「昵称（备注）」 |
| `domain` / `enterpriseId` | 可选，分别作为 `X-Domain` 与 `X-Enterprise-Id` / `X-Tenant-Id` |
| `expiresAt` | 可选毫秒时间戳；早于当前时间（留 60 秒余量）的账号会被跳过并说明原因 |

外层包一层 `{"accounts": [...]}` / `{"list": [...]}` 也能识别；`uid` 重复时保留先出现的那条。

**跳过而不是静默失败**：缺令牌、缺 `uid`、已过期、重复的账号都不会被跑，而是以
`昵称：已跳过（原因）` 的形式出现在通知末尾，所以「只跑了一个号」这件事永远看得见。

### 两种投喂方式

1. **直接粘贴**（简单）：把 `accounts-slim.py` 的输出粘进 BoxJS 的「账号池」字段。
2. **账号池 URL**（省事）：把 JSON 传到你自己的一个地址（私有 Gist、自己的服务器、
   对象存储都行），填进 `WorkBuddy_AccountsURL`。之后每轮都会去拉一次并写回本地缓存，
   拉的时候**不带任何认证头**（不会把 WorkBuddy 令牌泄露给托管方）。
   配了 URL 就以它为准 —— 以后电脑上重新导出，只要覆盖那份文件，手机端完全不用再动。
   拉取失败时自动回退到本地缓存的账号池，并在报告里注明。

> ⚠️ 账号池里是**能直接用的活令牌**。别提交进 Git 仓库（本目录的 `.gitignore` 已经挡掉
> `wb-switch-accounts-*.json` 和 `accounts.json`），也别贴到公开的地方；托管 URL 请选不可枚举的地址。
> 令牌有效期一般 30~40 天，过期后按上面两种方式任选一种更新即可。

### 预算怎么分

整轮共享 `WorkBuddy_Budget`（默认 540 秒，必须小于插件 cron 的 `timeout`），
每个账号分到 `min(240, 总额 / 账号数)` 秒；剩余预算不足 10 秒时，后面的账号记为
`总预算耗尽，本轮跳过`。所以**账号越多，每个号跑得越浅** —— 3 个账号约 180 秒/个，
足以跑完签到 + 全套成长中心；账号特别多时，建议把 `WorkBuddy_Budget` 调到 900 并把
cron 的 `timeout` 同步提到 960。

## 4. 运行逻辑与调度

| 触发 | 时间 | argument | 行为 |
|---|---|---|---|
| cron | 每天 00:05 | `auto` | 查签到状态 → 未签才领 → 成长中心全套 |
| cron | 每 4 小时 | `poll` | 先补签（未签才签）+ 完整成长中心 |
| http-request | 命中 `copilot.tencent.com/v2/` | — | 从手机端请求里抓 `Authorization` 写回 BoxJS |
| panel | 每 30 分钟 | `panel` | 读上次结果做卡片文字 |

每 4 小时的轮询是必要的：Buddy 出门旅行 1~4 小时就带礼物回来，只在 00:05 跑一次
礼物会压到第二天；同时它兼任签到兜底（00:05 撞上关机/睡眠/没网时，当天仍有机会补上）。
两个接口都幂等，重复触发不会重复领取。

成长中心步骤顺序与 `signin.py` 一致，且都各自 try——一段失败不影响其余领取：

```
旅行状态 → 领礼物(record_id) → 派出发(location_id)
        → 任务列表 → 接单(task_codes) → 领任务奖
        → 连登状态 + 活跃日历 → 补登(target_date，每轮最多 1 张卡)
        → 连登兑换(tier="7d"/"14d"/"28d" + client_token)
        → 抽奖机会 → 开盲盒(必须带 client_token)
        → Buddy 能量额度 → 开 Buddy 盲盒(count + client_token)
```

补登候选与源码同一套规则：**当月、今天之前、活动上线之后、`score == 0`、且不在
`makeup_dates` 里**，最近的断点优先；日历缺少 `today`/`cells`、分数非法或同一天记录冲突时
整段停止并标 `needs_attention`，绝不靠猜消耗补登卡。

## 5. 保鲜与续期（可选但强烈建议）

打开插件里的 `[MITM]` 后，只要**手机端自身**有请求打到 `copilot.tencent.com`，
`workbuddy.js` 就会把最新的 `Authorization` / `X-User-Id` 写回 BoxJS，令牌永不过期。
用的是账号池时，它会按 `X-User-Id` **只更新命中那一条**（整段 JSON 写回，保持原格式），
通知里会说明刷新的是哪个昵称；命中不了才回退到单账号的键。

手机端不访问这个域名时抓不到（MITM 只能看到手机自己发的流量），此时有两种选择：

- 保留 `[MITM]` 不管它——不命中就没有副作用；
- 定期在电脑上重跑 `accounts-slim.py`（多账号）或 `export-token.py`（单账号）更新 BoxJS 里的令牌。

令牌失效的表现是 `AUTH_ERROR / 令牌已失效（HTTP 401）：等同于密码错误`（WorkBuddy 没有密码，
凭据就是 `access_token`，所以 401 就等价于「密码错误」），脚本会明确通知你，不会静默。
### 自动续期（手机登录来的令牌才有）

账号池里带 `refresh_token` 的账号，脚本在跑之前会先续期（过期了、或 24 小时内要过期时），
成功后通知里会多一行 `⟳ 已自动续期：昵称`，并把新的 `access_token` / `refresh_token` 写回账号池。

有一条硬限制：**Keycloak 的 refresh_token 是绑定客户端的**。实测电脑版导出的令牌用
`account-console` / `account` / `admin-cli` 去续期都会得到
`invalid_grant: Invalid refresh token. Token client and authorized client don't match`，
用 `console` 续期则是 `401 unauthorized_client`（它要 client_secret，而手机端给不了）。
所以只有**手机登录页**（公开客户端 `account-console`）换来的令牌才能自己续下去——
这也正是推荐登录页的原因。续期失败时该账号会被跳过并通知
`自动续期失败（…），请重新登录：<登录页>`，不会拿废令牌死磕。

### 状态码 → 通知长什么样

| 状态 | 通知标题 / 副标题 | 含义与处置 |
|---|---|---|
| `SUCCESS` | `WorkBuddy 签到（N 个账号）/ SUCCESS +X 积分` | 领到东西了 |
| `ALREADY` | `… / ALREADY` | 今天已签过，成长中心没有可领的 |
| `INACTIVE` | `… / INACTIVE` | 不是签到季 / 活动未开启 |
| `AUTH_ERROR` | `… / AUTH_ERROR：令牌失效，去手机登录页重登` | **账号密码错误**那一类（WorkBuddy 没有密码，凭据就是 `access_token`）→ 去手机登录页重登一次 |
| `AUTH_REJECTED` | `… / AUTH_REJECTED：权限被拒绝（403）` | 令牌**能用但被服务端拦了**：未开通、被风控、企业账号权限不足 → 先确认账号状态，不是重新导出 |
| `NO_AUTH` | `WorkBuddy 未配置 / 没读到账号…` | 账号池没保存进去（粘贴后忘了点保存最常见） |
| 账号已失效 | `WorkBuddy 账号已失效 / 令牌过期且续期失败，需重新登录` | 全部账号要么过期要么续期失败，脚本直接告诉你去登录页，不会报含糊的「未配置」 |
| 临期预警 | 正文末尾 `⚠️ 令牌即将过期：昵称（2026-11-13，约 2 天内过期）` | 还有 3 天以内到期就提前提醒，`WorkBuddy_LastJSON.expiring` 也会标记；临期账号照常参与本轮 |
| 登录成功 | `WorkBuddy 登录成功 / 手机号账号 · 可用 ✓` | 手机登录回调已被脚本处理，令牌进账号池且能被续期 |
| 登录未验证 | `WorkBuddy 登录（令牌未验证通过） / …` | 令牌写进去了，但签到接口回报 401/403：这个客户端签发的令牌可能不被接受，在 BoxJS 里删掉这条即可 |

## 6. 排错

| 现象 | 处理 |
|---|---|
| 通知 `NO_AUTH / 未找到 accessToken` | BoxJS 里没填，或键名被改。确认 key 是 `WorkBuddy_Accounts`（多账号）或 `WorkBuddy_Token` |
| 通知 `AUTH_ERROR / 令牌已失效（HTTP 401）` | 令牌过期或凭据与账号不匹配（等同密码错误）→ 去手机登录页重登一次（或重跑 `accounts-slim.py` / `export-token.py`） |
| 通知 `AUTH_REJECTED / HTTP 403 权限被拒绝` | 令牌本身有效但服务端拒绝：账号未开通 / 被风控 / 企业账号权限不足，先确认账号状态 |
| 以后所有请求都 401 | 桌面端退出登录过、或换了账号，重新登录/导出即可 |
| 手机登录后没有通知 | ① 确认插件里有 `WorkBuddy手机登录` 这条规则、`[MITM]` 的 hostname 含 `www.codebuddy.cn`、且 Loon 的 MITM 开关和证书都正常；② 没走 Loon 就用登录页的「粘贴回调 URL」那条路 |
| 登录换令牌报 `invalid_grant: Code not valid` | 那个 `code` 已经用过或超过约 1 分钟：重新点一次登录，回调 URL 要当场粘贴 |
| 登录报 `unauthorized_client` | `WorkBuddy_LoginClient` 被改成了机密客户端（如 `console`）→ 填回 `account-console` |
| 续期报 `Token client and authorized client don't match` | 这条令牌是电脑端导出的，续不了；用手机登录页重登一次，让它带 `client` 字段 |
| 只有一部分账号跑到了 | 看通知末尾的 `已跳过（原因）`：过期 / 缺 uid / 重复都会被点名；`总预算耗尽，本轮跳过` 则调大 `WorkBuddy_Budget` |
| 配了账号池 URL 却报拉取失败 | 确认地址能从手机直接访问（HTTPS、无鉴权页）；失败时会自动用本地缓存，报告里会注明 |
| 从不通知 | 检查 BoxJS 的 `WorkBuddy_Notify` 是否为 1；轮询模式下空跑默认不通知，把 `WorkBuddy_LogEmpty` 设为 1 可看每轮结果 |
| 想看每轮细节 | BoxJS → 应用 → WorkBuddy → 查看 `WorkBuddy_LastReport` / `WorkBuddy_LastTime` / `WorkBuddy_LastJSON`（`LastJSON.accounts` 是每个账号的明细） |
| Loon 日志里报脚本超时 | 插件 `timeout` 必须大于脚本内 `GLOBAL_BUDGET = 540`，所以两条 cron 都设成 600 |
| 老是「今日旅行名额已用完」 | 正常：服务端每天只放行一次派出 |
| 连登兑换「进阶/巅峰」未解锁 | 正常：三档分别要连登满 7 / 14 / 28 天 |
| 抽到实物奖 | 通知会带「需到成长中心填写收件信息」——脚本不代填地址 |

## 7. 与 Python 版的差异

- **没有本地文件系统**：结果写在 BoxJS 键里（`WorkBuddy_LastReport` 等），不是 `signin.log`。
- **预算更短**：整轮 `GLOBAL_BUDGET = 540` 秒，每个账号分到 `min(240, 总额/账号数)` 秒（Python 版签到 420 / 轮询 180）。手机端后台调度更严格，宁可少领一轮也不要把任务跑穿。
- **多账号串行**：Python 版一次一个凭据文件；本版按账号池顺序串行跑，`uid` 去重、过期即跳过，结果逐账号汇总。
- **网络退避更轻**：只依赖 Loon 的 `$httpClient` 自身重试，没有 5/15/30/60/90 秒的长退避；靠每天 7 次触发来兜。
- **不打印令牌**：脚本从不输出 token，也不写进任何 BoxJS 键以外的位置。
- 签到状态查询与领取接口沿用 Python 版的重试容忍度（查询只读、领取幂等），其余写操作一律不重试，避免超时后重复提交。

## 8. 免责声明

本项目是非官方工具，与腾讯、WorkBuddy 无隶属关系；签到接口系对桌面端 `app.asar`
逆向所得，可能随时变更。请遵守相关服务条款，风险自负。
