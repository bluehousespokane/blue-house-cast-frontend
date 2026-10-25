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
    r"(?:html\s*,\s*body|body\s*,\s*html)\s*\{"
    r"[^}]*background(?:-color)?\s*:\s*"
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

before_cast_sdk = receiver_html[:cast_sdk_offset]
if 'id="cast-loading-screen"' not in before_cast_sdk:
    raise SystemExit("the loading screen must be present before the Cast SDK")

if 'id="cast-loading-particles"' not in before_cast_sdk:
    raise SystemExit("the loading particles must be present before the Cast SDK")

if 'id="cast-brightness-overlay"' not in before_cast_sdk:
    raise SystemExit("the brightness overlay must be present before the Cast SDK")

if "cast-loading-spinner" in before_cast_sdk:
    raise SystemExit(
        "the particle field is the loading indicator; do not add a second spinner"
    )

for color in ("#E8EEF4", "#005E88", "#F58220"):
    if color not in before_cast_sdk:
        raise SystemExit(f"loading screen is missing palette color {color}")

if "getContext" not in before_cast_sdk:
    raise SystemExit("the particle canvas bootstrap must precede the Cast SDK")

if "blueHouseCastLoadingScreen" not in before_cast_sdk:
    raise SystemExit("the loading-screen controller must precede the Cast SDK")

print(f"Cast receiver startup artifact verified: {receiver_path}")
