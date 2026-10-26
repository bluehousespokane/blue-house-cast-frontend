// Nessages to be processed inside the Cast Receiver app

import type { Auth } from "home-assistant-js-websocket";
import type { CastManager } from "./cast_manager";
import { CAST_DEV } from "./const";
import { CAST_DEV_HASS_URL } from "./dev_const";
import type { BaseCastMessage } from "./types";

export interface GetStatusMessage extends BaseCastMessage {
  type: "get_status";
  hassUrl?: string;
  hassUUID?: string;
}

export interface ConnectMessage extends BaseCastMessage {
  type: "connect";
  protocolVersion?: number;
  refreshToken: string;
  clientId: string | null;
  hassUrl: string;
  hassUUID?: string;
}

export interface ShowLovelaceViewMessage extends BaseCastMessage {
  type: "show_lovelace_view";
  protocolVersion?: number;
  sessionId?: string;
  requestId?: string;
  viewPath: string | number | null;
  urlPath: string | null;
  hassUrl: string;
  hassUUID?: string;
  vignetteSize?: number;
  brightnessPct?: number;
  settingsVersion?: number;
  keepAlive?: boolean;
  operationId?: string;
  /** Internal receiver-only marker used when restoring suspended content. */
  internalRestore?: boolean;
}

export interface SetBrightnessMessage extends BaseCastMessage {
  type: "set_brightness";
  brightnessPct: number;
  operationId?: string;
}

export interface ApplySettingsMessage extends BaseCastMessage {
  type: "apply_settings";
  protocolVersion: number;
  sessionId?: string;
  requestId?: string;
  settingsVersion: number;
  desktop: "particles" | "black";
  brightnessPct: number;
  vignetteSize: number;
  keepAlive: boolean;
}

export interface ReceiverControlMessage extends BaseCastMessage {
  type:
    "show_content" | "hide_content" | "unload_content" | "bring_to_foreground";
  protocolVersion?: number;
  sessionId?: string;
  requestId?: string;
}

export interface ShowDemoMessage extends BaseCastMessage {
  type: "show_demo";
}

export interface ShowLoadingScreenMessage extends BaseCastMessage {
  type: "show_loading_screen";
  operationId?: string;
}

export interface HideLoadingScreenMessage extends BaseCastMessage {
  type: "hide_loading_screen";
  operationId?: string;
}

export interface UnloadDashboardMessage extends BaseCastMessage {
  type: "unload_dashboard";
  operationId?: string;
}

export type HassMessage =
  | ShowDemoMessage
  | GetStatusMessage
  | ConnectMessage
  | ShowLovelaceViewMessage
  | SetBrightnessMessage
  | ApplySettingsMessage
  | ReceiverControlMessage
  | ShowLoadingScreenMessage
  | HideLoadingScreenMessage
  | UnloadDashboardMessage;

export const castSendAuth = (cast: CastManager, auth: Auth) =>
  cast.sendMessage({
    type: "connect",
    refreshToken: auth.data.refresh_token,
    clientId: auth.data.clientId,
    hassUrl: CAST_DEV ? CAST_DEV_HASS_URL : auth.data.hassUrl,
  });

export const castSendShowLovelaceView = (
  cast: CastManager,
  hassUrl: string,
  viewPath: ShowLovelaceViewMessage["viewPath"],
  urlPath?: string | null
) =>
  cast.sendMessage({
    type: "show_lovelace_view",
    viewPath,
    urlPath: urlPath || null,
    hassUrl: CAST_DEV ? CAST_DEV_HASS_URL : hassUrl,
  });

export const castSendShowDemo = (cast: CastManager) =>
  cast.sendMessage({
    type: "show_demo",
  });

export const ensureConnectedCastSession = (cast: CastManager, auth: Auth) => {
  if (cast.castConnectedToOurHass) {
    return undefined;
  }

  return new Promise<void>((resolve) => {
    const unsub = cast.addEventListener("connection-changed", () => {
      if (cast.castConnectedToOurHass) {
        unsub();
        resolve();
      }
    });

    castSendAuth(cast, auth);
  });
};
