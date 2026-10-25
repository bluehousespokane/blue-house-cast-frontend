import type { LovelaceConfig } from "../../../src/data/lovelace/config/types";

type LovelaceView = LovelaceConfig["views"][number];

export const isRequestedLovelaceViewReady = (
  views: readonly Pick<LovelaceView, "path">[] | undefined,
  urlPath: string | null | undefined,
  lovelacePath: string | number | null,
  hassConnected: boolean
): boolean =>
  !!views &&
  urlPath !== undefined &&
  hassConnected &&
  views.some((view, index) =>
    lovelacePath === null
      ? index === 0
      : view.path === lovelacePath ||
        index === Number.parseInt(String(lovelacePath), 10)
  );
