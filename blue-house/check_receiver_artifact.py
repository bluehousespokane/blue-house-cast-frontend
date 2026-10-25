#!/usr/bin/env python3

import argparse
import re
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("receiver_html", type=Path)
receiver_path = parser.parse_args().receiver_html
receiver_html = receiver_path.read_text()
style_matches = list(
    re.finditer(
        r"<style\b[^>]*>(.*?)</style>",
        receiver_html,
        re.DOTALL | re.IGNORECASE,
    )
)
if not style_matches:
    raise SystemExit("receiver.html has no inline startup styles")

cast_sdk_offset = receiver_html.find("cast_receiver_framework.js")
if cast_sdk_offset < 0:
    raise SystemExit("receiver.html has no Cast SDK script")

startup_styles = [
    match.group(1) for match in style_matches if match.start() < cast_sdk_offset
]
if not startup_styles:
    raise SystemExit("startup styles must appear before the Cast SDK script")

black_background = re.compile(
    r"html\s*,\s*body\s*\{[^}]*background(?:-color)?\s*:\s*"
    r"(?:#000(?:000)?\b|black\b)",
    re.DOTALL | re.IGNORECASE,
)
dark_color_scheme = re.compile(r"color-scheme\s*:\s*dark\b", re.IGNORECASE)
if not any(black_background.search(style) for style in startup_styles):
    details = " | ".join(" ".join(style.split())[:240] for style in startup_styles)
    raise SystemExit(
        "startup styles must set html and body to a black background; "
        f"styles before Cast SDK: {details}"
    )

if not any(dark_color_scheme.search(style) for style in startup_styles):
    raise SystemExit("startup styles must declare a dark color scheme")

print(f"Cast receiver startup artifact verified: {receiver_path}")
