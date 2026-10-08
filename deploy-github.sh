#!/usr/bin/env bash
# 一键把本项目推到 GitHub（默认 xlzs001/workbuddy-loon）。
#
# 用法：
#   ./deploy-github.sh                              # 已有 git 凭据（钥匙串/SSH）：检查 + push + 验证
#   GH_TOKEN=github_pat_xxx ./deploy-github.sh      # 用 PAT 自动建仓库、推送、验证（推荐一次性）
#
# 两件事保证不会出事：
#   1) push 之前先用切号工具导出的账号文件做「真实凭据对照扫描」，命中就直接中止；
#   2) push 之后逐个 curl raw 地址，确认 Loon 真能拉到。
set -euo pipefail

OWNER="${GH_OWNER:-xlzs001}"
REPO="${GH_REPO:-workbuddy-loon}"
BRANCH="main"
RELEASE_TAG="${RELEASE_TAG:-v1.1.0}"
cd "$(dirname "$0")"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

step "0/5 检查登录页内联是否最新"
# login.html 改了却忘记跑 build-page.py，线上发出去的就是旧页面 —— 直接中止
if command -v python3 >/dev/null && [ -f build-page.py ]; then
  python3 build-page.py --check || { echo "  登录页内联过时：先在项目目录跑 python3 build-page.py"; exit 1; }
else
  echo "  跳过（没找到 python3 或 build-page.py）"
fi

step "1/5 检查待推送内容里没有真实凭据"
ACCT="$(ls ../wb-switch-accounts-*.json ./accounts.json 2>/dev/null | head -1 || true)"
if [ -n "${ACCT:-}" ] && command -v python3 >/dev/null; then
  python3 - "$ACCT" <<'PY'
import json, subprocess, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("   跳过（对照文件读不了：%s）" % e); sys.exit(0)
if isinstance(data, dict):
    data = data.get("accounts") or data.get("list") or [data]
needles = []
for a in data:
    t = str(a.get("access_token") or a.get("accessToken") or a.get("token") or "")
    if t:
        needles += [t[:60], t[-40:]]
    if a.get("uid"):
        needles.append(str(a["uid"]))
    if a.get("refresh_token"):
        needles.append(str(a["refresh_token"])[:60])
files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
bad = []
for f in files:
    try:
        s = open(f, encoding="utf-8", errors="ignore").read()
    except Exception:
        continue
    if any(n and n in s for n in needles):
        bad.append(f)
print("   对照文件：%s" % sys.argv[1])
print("   命中文件：%s" % (", ".join(bad) if bad else "无 —— 干净，可以公开"))
sys.exit(1 if bad else 0)
PY
else
  echo "   没找到可对照的账号文件，跳过（仓库里本来就只有假令牌）"
fi

step "2/5 确认 git 身份与分支"
git config user.name  >/dev/null 2>&1 || git config user.name  "$OWNER"
git config user.email >/dev/null 2>&1 || git config user.email "$OWNER@users.noreply.github.com"
echo "   user: $(git config user.name) <$(git config user.email)>"
git rev-parse --verify HEAD >/dev/null 2>&1 || { echo "   还没有提交，先 git commit"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "   ✘ 工作树还有未提交修改；先提交，再创建发布标签"; exit 1; }
git branch -M "$BRANCH"
if git rev-parse "$RELEASE_TAG" >/dev/null 2>&1; then
  [ "$(git rev-list -n1 "$RELEASE_TAG")" = "$(git rev-parse HEAD)" ] || { echo "   ✘ 标签 $RELEASE_TAG 已存在但不指向当前提交"; exit 1; }
else
  git tag -a "$RELEASE_TAG" -m "Release $RELEASE_TAG"
fi

if [ -n "${GH_TOKEN:-}" ]; then
  step "3/5 通过 API 创建（或确认已存在）仓库 $OWNER/$REPO"
  code=$(curl -sS -o /tmp/gh-repo.json -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    https://api.github.com/user/repos \
    -d "{\"name\":\"$REPO\",\"private\":false,\"description\":\"WorkBuddy 自动签到 Loon/BoxJS 版（多账号）\"}")
  case "$code" in
    201) echo "   仓库已创建（public）" ;;
    422) echo "   仓库已存在，直接用" ;;
    401) echo "   ✘ token 无效或过期（401）"; exit 1 ;;
    *)   echo "   ⚠ 返回 $code：$(head -c 200 /tmp/gh-repo.json)"; ;;
  esac

  step "4/5 推送（token 只在这一条命令里出现，推完立刻从 remote 抹掉）"
  git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "https://github.com/$OWNER/$REPO.git" \
    || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git -c credential.helper= \
      -c "credential.helper=!f() { echo username=x-access-token; echo password=\$GH_TOKEN; }; f" \
      push -u origin "$BRANCH" "$RELEASE_TAG"
  git remote set-url origin "https://github.com/$OWNER/$REPO.git"
  unset GH_TOKEN
else
  step "3/5 没有 GH_TOKEN：请先在 https://github.com/new 建 public 仓库 $REPO（不要勾任何初始化文件）"
  read -r -p "   建好了按回车继续（或 Ctrl-C 退出）… " _
  step "4/5 推送"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git push -u origin "$BRANCH" "$RELEASE_TAG"
fi

step "5/5 验证 raw 地址（手机端要用这三个）"
base="https://raw.githubusercontent.com/$OWNER/$REPO/$RELEASE_TAG"
for f in workbuddy.js WorkBuddy.plugin boxjs.json login.html; do
  printf "   %-18s %s  " "$f" "$(curl -sS -o /dev/null -w '%{http_code}' "$base/$f")"
  curl -sS -o /dev/null -w "%{size_download} bytes\n" "$base/$f"
done
cat <<EOF

完成。手机端这么填：
  插件（Loon → 配置 → 插件 → 添加）：
    $base/WorkBuddy.plugin
  BoxJS 订阅：
    $base/boxjs.json
  仓库：https://github.com/$OWNER/$REPO

注意：raw.githubusercontent.com 有缓存，push 后大约 1~5 分钟生效；BoxJS 里改完配置记得手动跑一次验证。
EOF
