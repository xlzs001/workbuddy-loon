#!/usr/bin/env python3
"""把 login.html 内联进 workbuddy.js 的 PAGE_HTML 常量。

为什么需要这一步：手机登录页默认由 Loon 直接提供（脚本 argument=page 吐出 HTML），
页面地址是 https://www.codebuddy.cn/wb-login —— 走插件自己的 MITM，
不依赖 GitHub Pages / jsDelivr 能不能访问。改完 login.html 后跑一次本脚本即可。

用法：
    python3 build-page.py          # 重新内联
    python3 build-page.py --check  # 只检查是否为最新（测试用，过时返回 1）
"""
import io
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
HTML_PATH = os.path.join(BASE, "login.html")
JS_PATH = os.path.join(BASE, "workbuddy.js")

BEGIN = "/* ==== PAGE_HTML:BEGIN（由 build-page.py 从 login.html 生成，勿手改）==== */"
END = "/* ==== PAGE_HTML:END ==== */"
PAT = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.S)


def main():
    html = io.open(HTML_PATH, encoding="utf-8").read()
    js = io.open(JS_PATH, encoding="utf-8").read()
    lit = json.dumps(html, ensure_ascii=False)
    # U+2028/2029 在老引擎里会断行，转义掉更安全
    lit = lit.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    block = BEGIN + "\nvar PAGE_HTML = " + lit + ";\n" + END
    if not PAT.search(js):
        sys.exit("找不到 PAGE_HTML 标记块，workbuddy.js 被改坏了？")
    new = PAT.sub(lambda m: block, js, count=1)
    if new == js:
        print("PAGE_HTML 已是最新（login.html %d 字节）" % len(html.encode("utf-8")))
        return 0
    if "--check" in sys.argv:
        print("PAGE_HTML 与 login.html 不一致 —— 请先跑 python3 build-page.py")
        return 1
    io.open(JS_PATH, "w", encoding="utf-8").write(new)
    print("已内联：login.html %d 字节 → workbuddy.js %d 字节"
          % (len(html.encode("utf-8")), len(new.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
