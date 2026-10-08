#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 令牌导出器 —— 把桌面端登录态导出成 Loon/BoxJS 需要的三项凭据。

用法（在装有 WorkBuddy 桌面端、且已登录的电脑上运行）：

    python3 export-token.py /path/to/workbuddy-auto-signin

它会直接复用 workbuddy-auto-signin 自己的探测 + 解密逻辑：
  - 明文凭据（旧版 / Linux CodeBuddy CLI）直接读出 accessToken
  - 新版 $wbEncrypted 信封走客户端原生解密子进程，与 signin.py 行为完全一致

输出：一行 JSON，含 token / uid / enterpriseId / domain。
把 token 和 uid 填进 BoxJS 的 WorkBuddy 面板即可。脚本不会写任何文件。
"""
import json
import os
import sys


def main():
    repo = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, repo)
    try:
        import signin  # noqa: E402
    except Exception as e:  # pragma: no cover
        _fail("无法导入 signin.py（%s）。请把仓库路径作为第一个参数传入" % e)

    path, looked_in = signin.find_auth_file()
    if not path:
        _fail("未找到登录凭据文件，先登录一次 WorkBuddy 桌面端。已检查：\n  " + "\n  ".join(looked_in))

    try:
        session = signin.load_session_retry(path)
    except Exception as e:
        _fail("读取凭据失败（%s: %s）" % (type(e).__name__, e))

    try:
        session = signin.resolve_session(session)
        headers = signin.build_headers(session)
    except Exception as e:
        _fail("解密/构建请求头失败：%s" % e)

    auth = headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        _fail("凭据里没有可用的 accessToken")

    account = (session.get("account") or {})
    uid = headers.get("X-User-Id") or account.get("uid")
    if not uid:
        _fail("凭据里没有可用的 uid（X-User-Id）")
    out = {
        "token": auth.split(" ", 1)[1],
        "uid": uid,
        "enterpriseId": headers.get("X-Enterprise-Id") or account.get("enterpriseId") or "",
        "domain": headers.get("X-Domain") or (session.get("auth") or {}).get("domain") or "",
    }
    print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return 0


def _fail(msg):
    print(json.dumps({"error": msg}, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    sys.exit(main())
