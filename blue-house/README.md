# Blue House Cast receiver fork

This branch keeps Home Assistant's Cast receiver and shared Lovelace renderer.
It is built with the upstream Cast target. Source changes are normal Git
commits; builds do not rewrite upstream files.

The receiver-specific changes are limited to:

- `src/cast/const.ts`: the registered application ID and message namespace.
- `cast/src/html/receiver.html.template`: black background before scripts load.
- `cast/src/receiver/layout/hc-launch-screen.ts`: a black waiting screen that
  still displays connection errors.
- `cast/src/receiver/layout/hc-main.ts` and `src/cast/sender_messages.ts`:
  additive visibility and configured-view readiness status for the launcher.

Authentication, dashboard rendering, custom-card loading, navigation, and media
handling continue to use upstream code. The status extensions do not establish
that every card has rendered successfully.

## Upstream updates

The **Blue House Cast checks and upstream sync** workflow checks the latest
published, non-prerelease frontend release daily. It merges that release into
a candidate checkout, runs formatting, focused Cast tests, TypeScript checks,
and the Cast production build, then advances `blue-house` only after success.
It never forces a merge. Conflicts or validation failures leave the branch
unchanged and fail the workflow for review.

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
pnpm test test/cast/
pnpm lint:types
SKIP_FETCH_NIGHTLY_TRANSLATIONS=1 pnpm exec gulp build-cast
```

The environment variable skips an optional interactive translation download;
the upstream base translations remain. Output is under `cast/dist` and is
generated runtime material, not source for this branch. The upstream license
must accompany distributed receiver files.
