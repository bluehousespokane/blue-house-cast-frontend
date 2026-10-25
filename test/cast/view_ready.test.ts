import { assert, describe, it } from "vitest";
import { isRequestedLovelaceViewReady } from "../../cast/src/receiver/view_ready";

const views = [{ path: "overview" }, { path: "morning" }];

describe("requested Cast Lovelace view readiness", () => {
  it("waits until config, dashboard path, and HA connection are ready", () => {
    assert.isFalse(
      isRequestedLovelaceViewReady(undefined, "dashboard", null, true)
    );
    assert.isFalse(isRequestedLovelaceViewReady(views, undefined, null, true));
    assert.isFalse(
      isRequestedLovelaceViewReady(views, "dashboard", null, false)
    );
  });

  it("recognizes the default, named, and numeric-index views", () => {
    assert.isTrue(isRequestedLovelaceViewReady(views, null, null, true));
    assert.isTrue(
      isRequestedLovelaceViewReady(views, "dashboard", "morning", true)
    );
    assert.isTrue(isRequestedLovelaceViewReady(views, "dashboard", "1", true));
    assert.isTrue(isRequestedLovelaceViewReady(views, "dashboard", 1, true));
  });

  it("does not report a requested view that is absent", () => {
    assert.isFalse(
      isRequestedLovelaceViewReady(views, "dashboard", "evening", true)
    );
    assert.isFalse(isRequestedLovelaceViewReady([], "dashboard", null, true));
  });
});
