#!/usr/bin/env python3
"""把账号 JSON 压成可以直接粘进 BoxJS「WorkBuddy_Accounts」的值。

输入：切号工具导出的账号文件（顶层是数组，元素含 access_token/uid/nickname…），
      也接受单账号对象、或 {"accounts": [...]} 这类包一层的形式；可一次给多个文件。
输出：一行紧凑 JSON，只保留脚本真正要用的字段（nickname/token/uid/domain/expiresAt/note），
      把 profile_raw / auth_raw 这类几 KB 的无用大字段丢掉（19KB → 约 1KB，方便在手机上粘贴）。

用法：
    python3 accounts-slim.py wb-switch-accounts-2026-10-06.json
    # 默认复制到剪贴板，终端只显示不含令牌的摘要
    python3 accounts-slim.py --stdout *.json > accounts.json
    python3 accounts-slim.py --output accounts.json *.json

安全提醒：输出里含**真实令牌**，不要提交进任何仓库、不要粘到公开聊天里。
"""

import argparse
import datetime
import json
import shutil
import subprocess
import sys

KEEP_NOTE = "note"


def iter_records(data):
    """把各种形状的输入摊平成账号记录列表。"""
    if isinstance(data, str):
        data = json.loads(data)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("accounts", "list", "records", "data", "result"):
            if isinstance(data.get(key), list):
                return data[key]
        return [data]
    return []


def slim(rec, idx):
    if not isinstance(rec, dict):
        return None, "第 %d 条不是对象" % (idx + 1)
    prof = rec.get("profile_raw") if isinstance(rec.get("profile_raw"), dict) else {}
    auth = rec.get("auth_raw") if isinstance(rec.get("auth_raw"), dict) else {}

    token = rec.get("access_token") or rec.get("accessToken") or rec.get("token") or auth.get("accessToken") or ""
    token = str(token).strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if not token:
        return None, "第 %d 条没有 access_token" % (idx + 1)

    uid = rec.get("uid") or rec.get("userId") or prof.get("uid") or ""
    if not uid:
        return None, "第 %d 条没有 uid（X-User-Id）" % (idx + 1)

    out = {"nickname": str(rec.get("nickname") or prof.get("nickname") or ("账号 %d" % (idx + 1))),
           "access_token": token,
           "uid": str(uid)}
    note = rec.get(KEEP_NOTE)
    if note:
        out["note"] = str(note)
    domain = rec.get("domain") or auth.get("domain") or ""
    if domain:
        out["domain"] = str(domain)
    ent = rec.get("enterpriseId")
    if ent:
        out["enterpriseId"] = str(ent)
    exp = rec.get("expiresAt")
    if isinstance(exp, (int, float)) and exp > 1e12:
        out["expiresAt"] = int(exp)
    return out, None


def human(ms):
    try:
        return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return "?"


def main():
    ap = argparse.ArgumentParser(add_help=True, description="压缩账号 JSON 供 BoxJS 使用")
    ap.add_argument("files", nargs="+", help="账号 JSON 文件（可多个）")
    ap.add_argument("--no-clip", action="store_true", help="不写入剪贴板")
    ap.add_argument("--stdout", action="store_true", help="把含真实令牌的完整 JSON 输出到 stdout")
    ap.add_argument("--output", help="把含真实令牌的完整 JSON 写入指定文件")
    ap.add_argument("--keep-expired", action="store_true", help="保留已过期账号（默认剔除）")
    ap.add_argument("--pretty", action="store_true", help="完整 JSON 使用缩进格式（配合 --stdout/--output）")
    args = ap.parse_args()

    out, skipped, seen = [], [], set()
    for path in args.files:
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
        except Exception as e:
            print("!! 读取 %s 失败：%s" % (path, e), file=sys.stderr)
            continue
        for i, rec in enumerate(iter_records(data)):
            item, err = slim(rec, i)
            if err:
                skipped.append(err)
                continue
            if item["uid"] in seen:
                skipped.append("%s：uid 重复，已合并" % item["nickname"])
                continue
            exp = item.get("expiresAt")
            if exp and exp < int(datetime.datetime.now().timestamp() * 1000) and not args.keep_expired:
                skipped.append("%s：令牌已过期（%s）" % (item["nickname"], human(exp)))
                continue
            seen.add(item["uid"])
            out.append(item)

    if not out:
        print("!! 没有可用账号。" + ("；".join(skipped) if skipped else ""), file=sys.stderr)
        return 1

    text = json.dumps(out, ensure_ascii=False, indent=2 if args.pretty else None)
    delivered = False
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text)
            f.write("\n")
        print("→ 已写入 %s" % args.output, file=sys.stderr)
        delivered = True
    if args.stdout:
        print(text)
        delivered = True
    if not args.no_clip:
        clip_commands = []
        if sys.platform == "darwin":
            clip_commands.append(["pbcopy"])
        elif sys.platform.startswith("win"):
            clip_commands.append(["clip"])
        else:
            clip_commands.extend([["wl-copy"], ["xclip", "-selection", "clipboard"]])
        for cmd in clip_commands:
            if shutil.which(cmd[0]):
                try:
                    subprocess.run(cmd, input=text.encode("utf-8"), check=True)
                    print("→ 已复制到剪贴板（%s）" % cmd[0], file=sys.stderr)
                    delivered = True
                except Exception as e:
                    print("→ 复制失败：%s" % e, file=sys.stderr)
                break
    if not delivered:
        print("!! 未输出敏感令牌：没有可用剪贴板工具。请使用 --stdout 或 --output FILE。", file=sys.stderr)
        return 2

    print("→ 共 %d 个账号，%d 字节" % (len(out), len(text)), file=sys.stderr)
    for name, exp in [(o["nickname"], o.get("expiresAt")) for o in out]:
        print("   • %s   令牌有效至 %s" % (name, human(exp) if exp else "未知（未提供）"), file=sys.stderr)
    for s in skipped:
        print("   ⚠ %s" % s, file=sys.stderr)
    print("→ 粘贴到 BoxJS 的 WorkBuddy_Accounts 字段即可（该值含真实令牌，勿入仓库）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
