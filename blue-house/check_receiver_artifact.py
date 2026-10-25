#!/usr/bin/env python3

import argparse
import re
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("receiver_html", type=Path)
receiver_path = parser.parse_args().receiver_html
receiver_html = receiver_path.read_text()
style_match = re.search(r"<style>(.*?)</style>", receiver_html, re.DOTALL)
if style_match is None:
    raise SystemExit("receiver.html has no inline startup styles")

cast_sdk_offset = receiver_html.find("cast_receiver_framework.js")
if cast_sdk_offset < 0 or style_match.start() > cast_sdk_offset:
    raise SystemExit("startup styles must appear before the Cast SDK script")

startup_styles = style_match.group(1)
if not re.search(
    r"html\s*,\s*body\s*\{[^}]*background\s*:\s*#000\b",
    startup_styles,
    re.DOTALL,
):
    raise SystemExit("startup styles must set html and body to a black background")

if not re.search(r"color-scheme\s*:\s*dark\b", startup_styles):
    raise SystemExit("startup styles must declare a dark color scheme")

print(f"Cast receiver startup artifact verified: {receiver_path}")
