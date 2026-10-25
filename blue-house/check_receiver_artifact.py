#!/usr/bin/env python3

import argparse
import re
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("receiver_html", type=Path)
receiver_path = parser.parse_args().receiver_html
receiver_html = receiver_path.read_text()
source_template = (
    Path(__file__).resolve().parent.parent
    / "cast/src/html/receiver.html.template"
).read_text()
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

if "cast-loading-spinner" in before_cast_sdk:
    raise SystemExit(
        "the particle field is the loading indicator; do not add a second spinner"
    )

for color in ("#E8EEF4", "#005E88", "#F58220"):
    if color not in before_cast_sdk:
        raise SystemExit(f"loading screen is missing palette color {color}")

if "getContext" not in before_cast_sdk:
    raise SystemExit("the particle canvas bootstrap must precede the Cast SDK")

source_sdk_offset = source_template.find("cast_receiver_framework.js")
if source_sdk_offset < 0:
    raise SystemExit("the receiver source template has no Cast SDK script")
source_before_cast_sdk = source_template[:source_sdk_offset]

start_particles = re.search(
    r"const\s+startParticles\s*=\s*\(\)\s*=>\s*\{(.*?)\}\s*;?\s*"
    r"const\s+drawParticles",
    source_before_cast_sdk,
    re.DOTALL,
)
if not start_particles or not re.search(
    r"drawParticles\(performance\.now\(\)\)", start_particles.group(1)
):
    raise SystemExit("the particle loader must draw its first frame synchronously")

if not re.search(r"startParticles\(\);\s*\}\)\(\);", source_before_cast_sdk):
    raise SystemExit("the particle loader must start before the Cast SDK is loaded")

if not re.search(
    r"Array\(60\)\.fill\(\"#E8EEF4\"\).*?"
    r"Array\(30\)\.fill\(\"#005E88\"\).*?"
    r"Array\(10\)\.fill\(\"#F58220\"\)",
    source_before_cast_sdk,
    re.DOTALL,
):
    raise SystemExit("particles must use 60 off-white, 30 blue, and 10 orange dots")

if not re.search(
    r"setTimeout\(\s*\(\)\s*=>\s*finishLoading\(true\),\s*2000\s*\)",
    source_before_cast_sdk,
):
    raise SystemExit(
        "the receiver should hold the reveal for the selected 2-second settle"
    )

print(f"Cast receiver startup artifact verified: {receiver_path}")
