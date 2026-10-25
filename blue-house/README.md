# Blue House Cast receiver fork

This branch keeps Home Assistant's Cast receiver and shared Lovelace renderer.
It is built with the upstream Cast target. Source changes are normal Git
commits; builds do not rewrite upstream files.

The receiver-specific changes are limited to:

- `src/cast/const.ts`: the registered application ID and message namespace.
- `cast/src/html/receiver.html.template`, `_loading_particles.js`, and
  `_loading_screen.js`: inline black cover, shared particle renderer, and
  circular reveal before any external scripts load. The ordinary template
  includes inline these checked-in sources; there is no additional loader request.
- `cast/src/receiver/layout/hc-launch-screen.ts`: a black waiting screen that
  still displays connection errors.
- `cast/src/receiver/layout/hc-main.ts`, `hc-lovelace.ts`, and
  `cast/src/receiver/entrypoint.ts`: cover before swapping or unloading a view,
  keep the receiver connected, and acknowledge completed operations.
- `src/cast/receiver_messages.ts` and `sender_messages.ts`: additive loading
  controls, render generation, visibility, and operation status.

Authentication, dashboard rendering, custom-card loading, navigation, and media
handling continue to use upstream code. The status extensions do not establish
that every card has rendered successfully.

## Loading and view changes

The black cover appears immediately, without a particle library. SDK and
frontend loading wait for the first particle draw and an initial paint. Density
scales with viewport area and is capped at 350 particles. Counts retain approximately
60% `#E8EEF4`, 30% `#005E88`, and 10% `#F58220`. The 80% canvas and 30% layer
opacity match the supplied design. Motion uses the original particles.js
speed calculation, edge bounce, independent blue opacity animation, light and
orange size animation, light attraction, and blue pointer grab. Drawing pauses
after the cover is hidden; reduced motion uses a static field.

For every show-view request, the old dashboard stays in place until the cover
is opaque and has painted. The next view mounts with a fresh render generation, including a
repeat request for the same view. After its render event, a two-second settle
allows media and asynchronous cards to start. The cover then reveals the page
from the viewport center over five seconds, with a 75vw feather and the supplied
smootherstep alpha profile. The whole cover is masked so particles disappear
with the black layer. Covering uses the same five-second circle in reverse. Reduced
motion completes both transitions immediately.

`show_loading_screen` holds the opaque cover without removing the dashboard.
`hide_loading_screen` reveals the current content. `unload_dashboard` covers
first, removes the view and its Lovelace subscription, and keeps the receiver
and Home Assistant connection open. A later show-view request loads and reveals
normally. An optional `operationId` is echoed as `completedOperationId` only
when that command's required transition has completed, preventing an earlier
status from acknowledging a new action. Ordinary upstream messages remain
supported without an operation ID.

## Upstream updates

The **Blue House Cast checks and upstream sync** workflow supports manual
dispatch and a daily release schedule. The schedule is enabled only after a
manual upstream merge has passed. When enabled, it checks the latest published,
non-prerelease frontend release, merges it into a candidate checkout, runs
formatting, focused Cast tests, TypeScript checks, and the Cast production
build, then advances `blue-house` only after success. It never forces a merge.
Conflicts or validation failures leave the branch unchanged and fail the
workflow for review.

Run the workflow manually with `sync_upstream` enabled to request the same
update. Without that option it validates the selected branch as-is.

Updating this source branch does not deploy a receiver. The deployment
repository selects an immutable fork commit, records its upstream release,
and builds that revision for hosting. Production selection should be checked
against the installed Home Assistant version and a real Cast device. A clean
merge and successful compilation alone do not prove runtime compatibility.

## Build and validation

Use Node from `.nvmrc` and pnpm from `package.json`, then:

```sh
pnpm install --frozen-lockfile
node blue-house/loading_screen.test.mjs
pnpm test test/cast/
SKIP_FETCH_NIGHTLY_TRANSLATIONS=1 pnpm exec gulp build-cast
python3 blue-house/check_receiver_artifact.py cast/dist/receiver.html
pnpm exec gulp gather-gallery-pages
pnpm lint:types
```

The environment variable skips an optional interactive translation download;
the upstream base translations remain. Output is under `cast/dist` and is
generated runtime material, not source for this branch. The upstream license
must accompany distributed receiver files.

The dependency-free loading-screen tests execute the actual inline bootstrap
with a controlled clock. They cover the first synchronous draw, palette and
density, motion, circular reveal, hold and reuse, interrupted transitions,
reduced motion, and unavailable canvas. The artifact check separately verifies
that generated startup styles, the cover, and the bootstrap precede the Cast
SDK. CI also runs formatting, ESLint, Cast tests, the Cast build, and full
TypeScript checking for the exact source commit.

The loading transition uses the same five-second circular reveal in reverse,
with a matching reversed timing curve. Dashboard DOM and video initialize while
the cover is opaque; hiding the dashboard DOM would postpone that preparation.
The optional `vignetteSize` message field adds a black edge fade in CSS pixels
above the dashboard (zero disables it). It resets for each view request and on
unload, and does not affect the loading screen or Cast media player.

`loadingPerformance` status contains bounded numeric aggregates for startup,
mounting, mounted, and unloaded phases: animation-frame gaps, frames over 50ms,
and particle draw time. It includes no dashboard content or network payloads.
Frame timings measure renderer scheduling, not GPU presentation or video
readiness. Drawing is capped at 25fps; animation-frame gaps measure RAF cadence.

## Particle scheduling

A fresh receiver starts with three active particles. After three healthy
animation callbacks, each particle draw can add at most one more. A callback
gap above 40ms suspends growth until callbacks recover; elapsed time never
causes a catch-up burst. Only active particles participate in drawing and
attraction. Final color counts retain the requested proportions. Reduced
motion draws the complete static field.

The renderer transfers the canvas to a Blob worker when OffscreenCanvas and
worker animation frames are available. SDK/frontend execution can then block
the page thread without also blocking particle updates. One self-contained
renderer function serves both worker and main-thread fallback; simulation code
is not duplicated. Unsupported, failed, or stalled worker startup falls back
to a fresh main-thread canvas. Worker readiness is bounded at 1.5 seconds.
Drawing pauses while the cover or document is hidden and resumes without
counting hidden time as a frame gap. Workers terminate on page teardown.

Status includes `renderer`, active and target particle counts, and maximum draw
callback gap as well as the existing per-phase measurements. Worker counters
measure worker callbacks and drawing submission, not presented display frames.
Use the Cast DevTools socket through ADB to inspect actual startup frame traces.
