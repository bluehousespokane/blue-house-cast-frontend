import type { UnsubscribeFunc } from "home-assistant-js-websocket";
import { createConnection, getAuth } from "home-assistant-js-websocket";
import type { TemplateResult, PropertyValues } from "lit";
import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators";
import { keyed } from "lit/directives/keyed";
import { CAST_NS } from "../../../../src/cast/const";
import type {
  ConnectMessage,
  GetStatusMessage,
  HassMessage,
  HideLoadingScreenMessage,
  ShowDemoMessage,
  ShowLovelaceViewMessage,
  ShowLoadingScreenMessage,
  UnloadDashboardMessage,
} from "../../../../src/cast/receiver_messages";
import type {
  LoadingPerformance,
  ReceiverErrorMessage,
  ReceiverStatusMessage,
} from "../../../../src/cast/sender_messages";
import { ReceiverErrorCode } from "../../../../src/cast/sender_messages";
import { atLeastVersion } from "../../../../src/common/config/version";
import { isNavigationClick } from "../../../../src/common/dom/is-navigation-click";
import type { HASSDomEvent } from "../../../../src/common/dom/fire_event";
import {
  getLegacyLovelaceCollection,
  getLovelaceCollection,
} from "../../../../src/data/lovelace";
import type {
  LegacyLovelaceConfig,
  LovelaceConfig,
  LovelaceDashboardStrategyConfig,
} from "../../../../src/data/lovelace/config/types";
import { isStrategyDashboard } from "../../../../src/data/lovelace/config/types";
import { fetchResources } from "../../../../src/data/lovelace/resource";
import { loadLovelaceResources } from "../../../../src/panels/lovelace/common/load-resources";
import { HassElement } from "../../../../src/state/hass-element";
import { castContext } from "../cast_context";
import "./hc-launch-screen";
import { getPanelTitleFromUrlPath } from "../../../../src/data/panel";
import { checkLovelaceConfig } from "../../../../src/panels/lovelace/common/check-lovelace-config";
import { isRequestedLovelaceViewReady } from "../view_ready";
import type { CastViewChanged } from "./hc-lovelace";

const DEFAULT_CONFIG: LovelaceDashboardStrategyConfig = {
  strategy: {
    type: "original-states",
  },
};

let resourcesLoaded = false;

interface ReceiverLoadingScreen {
  ready: Promise<void>;
  show(hold?: boolean): Promise<boolean>;
  hide(): Promise<boolean>;
  scheduleReveal(): void;
  setPhase(phase: "startup" | "mounting" | "mounted" | "unloaded"): void;
  getPerformance(): LoadingPerformance;
  subscribe(listener: (visible: boolean) => void): () => void;
}

@customElement("hc-main")
export class HcMain extends HassElement {
  @state() private _showDemo = false;

  @state() private _loadingScreenVisible = true;

  @state() private _dashboardLoaded = false;

  @state() private _viewGeneration = 0;

  @state() private _vignetteSize = 0;

  static styles = css`
    .vignette {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      background:
        linear-gradient(to right, #000, transparent var(--vignette-size)),
        linear-gradient(to left, #000, transparent var(--vignette-size)),
        linear-gradient(to bottom, #000, transparent var(--vignette-size)),
        linear-gradient(to top, #000, transparent var(--vignette-size));
    }
  `;

  @state() private _lovelaceConfig?: LovelaceConfig;

  @state() private _lovelacePath: string | number | null = null;

  @state() private _urlPath?: string | null;

  @state() private _error?: string;

  private _hassUUID?: string;

  private _unsubLovelace?: UnsubscribeFunc;

  private _unsubLoadingScreen?: () => void;

  private _loadGeneration = 0;

  private _configGeneration = 0;

  private _expectedViewGeneration = 0;

  private _pendingViewOperationId?: string;

  private _completedOperationId?: string;

  private _handleVisibilityChange = () => this._sendStatus();

  public connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._handleVisibilityChange);
    this.addEventListener("cast-view-changed", this._handleCastViewChanged);
    this._unsubLoadingScreen = window.blueHouseCastLoadingScreen?.subscribe(
      (visible) => {
        this._loadingScreenVisible = visible;
        if (!visible && this._dashboardLoaded && this._pendingViewOperationId) {
          this._completedOperationId = this._pendingViewOperationId;
          this._pendingViewOperationId = undefined;
        }
        this._sendStatus();
      }
    );
  }

  public disconnectedCallback() {
    document.removeEventListener(
      "visibilitychange",
      this._handleVisibilityChange
    );
    this.removeEventListener("cast-view-changed", this._handleCastViewChanged);
    this._unsubLoadingScreen?.();
    this._unsubLoadingScreen = undefined;
    super.disconnectedCallback();
  }

  public processIncomingMessage(msg: HassMessage) {
    if (msg.type === "connect") {
      this._handleConnectMessage(msg);
    } else if (msg.type === "show_lovelace_view") {
      this._handleShowLovelaceMessage(msg);
    } else if (msg.type === "get_status") {
      this._handleGetStatusMessage(msg);
    } else if (msg.type === "show_demo") {
      this._handleShowDemo(msg);
    } else if (msg.type === "show_loading_screen") {
      this._handleShowLoadingScreen(msg);
    } else if (msg.type === "hide_loading_screen") {
      this._handleHideLoadingScreen(msg);
    } else if (msg.type === "unload_dashboard") {
      this._handleUnloadDashboard(msg);
    } else {
      // eslint-disable-next-line no-console
      console.warn("unknown msg type", msg);
    }
  }

  protected render(): TemplateResult | typeof nothing {
    if (this._showDemo) {
      return html` <hc-demo .lovelacePath=${this._lovelacePath}></hc-demo> `;
    }

    if (
      !this._lovelaceConfig ||
      this._urlPath === undefined ||
      // Guard against part of HA not being loaded yet.
      !this.hass ||
      !this.hass.states ||
      !this.hass.config ||
      !this.hass.services
    ) {
      if (!this._error) {
        return nothing;
      }
      return html`
        <hc-launch-screen
          .hass=${this.hass}
          .error=${this._error}
        ></hc-launch-screen>
      `;
    }
    return html`${keyed(
      this._viewGeneration,
      html`
        <hc-lovelace
          .hass=${this.hass}
          .lovelaceConfig=${this._lovelaceConfig}
          .urlPath=${this._urlPath}
          .viewPath=${this._lovelacePath}
          .renderGeneration=${this._viewGeneration}
          @config-refresh=${this._generateDefaultLovelaceConfig}
        ></hc-lovelace>
      `
    )}${
      this._vignetteSize > 0
        ? html`<div
            class="vignette"
            aria-hidden="true"
            style=${`--vignette-size: ${this._vignetteSize}px`}
          ></div>`
        : nothing
    }`;
  }

  protected firstUpdated(changedProps: PropertyValues<this>) {
    super.firstUpdated(changedProps);
    this._sendStatus();
    import("./hc-lovelace");
    import("../../../../src/resources/append-ha-style");

    window.addEventListener("location-changed", () => {
      const panelPath = `/${this._urlPath || "lovelace"}/`;
      if (location.pathname.startsWith(panelPath)) {
        this._lovelacePath = location.pathname.substr(panelPath.length);
        this._dashboardLoaded = false;
        this._sendStatus();
      }
    });
    document.body.addEventListener("click", (ev) => {
      const panelPath = `/${this._urlPath || "lovelace"}/`;
      const href = isNavigationClick(ev);
      if (href && href.startsWith(panelPath)) {
        this._lovelacePath = href.substr(panelPath.length);
        this._dashboardLoaded = false;
        this._sendStatus();
      }
    });
    this.addEventListener("dialog-closed", this._dialogClosed);
  }

  private _sendStatus(senderId?: string) {
    const status: ReceiverStatusMessage = {
      type: "receiver_status",
      connected: !!this.hass?.connected,
      showDemo: this._showDemo,
      visible: document.visibilityState === "visible",
      viewReady: isRequestedLovelaceViewReady(
        this._lovelaceConfig?.views,
        this._urlPath,
        this._lovelacePath,
        !!this.hass?.connected
      ),
      loadingScreenVisible: this._loadingScreenVisible,
      dashboardLoaded: this._dashboardLoaded,
      vignetteSize: this._vignetteSize,
      loadingPerformance: window.blueHouseCastLoadingScreen?.getPerformance(),
      completedOperationId: this._completedOperationId,
    };

    if (this.hass) {
      status.hassUrl = this.hass.auth.data.hassUrl;
      status.hassUUID = this._hassUUID;
      status.lovelacePath = this._lovelacePath;
      status.urlPath = this._urlPath;
    }

    if (senderId) {
      this._sendMessage(senderId, status);
    } else {
      for (const sender of castContext.getSenders()) {
        this._sendMessage(sender.id, status);
      }
    }
  }

  private _sendError(
    error_code: number,
    error_message: string,
    senderId?: string
  ) {
    const error: ReceiverErrorMessage = {
      type: "receiver_error",
      error_code,
      error_message,
    };

    if (senderId) {
      this._sendMessage(senderId, error);
    } else {
      for (const sender of castContext.getSenders()) {
        this._sendMessage(sender.id, error);
      }
    }
  }

  private _dialogClosed = () => {
    document.body.setAttribute("style", "overflow-y: auto !important");
  };

  private async _handleGetStatusMessage(msg: GetStatusMessage) {
    if (
      (this.hass && msg.hassUUID && msg.hassUUID !== this._hassUUID) ||
      (this.hass && msg.hassUrl && msg.hassUrl !== this.hass.auth.data.hassUrl)
    ) {
      this._error = "Not connected to the same Home Assistant instance.";
      this._sendError(
        ReceiverErrorCode.WRONG_INSTANCE,
        this._error,
        msg.senderId!
      );
    }

    this._sendStatus(msg.senderId!);
  }

  private async _handleConnectMessage(msg: ConnectMessage) {
    if (this._hassUUID && this._hassUUID !== msg.hassUUID) {
      this._loadGeneration += 1;
      await this._showLoadingScreen(true);
    }
    let auth;
    try {
      auth = await getAuth({
        loadTokens: async () => ({
          hassUrl: msg.hassUrl,
          clientId: msg.clientId,
          refresh_token: msg.refreshToken,
          access_token: "",
          expires: 0,
          expires_in: 0,
        }),
      });
    } catch (err: any) {
      const errorMessage = this._getErrorMessage(err);
      this._error = errorMessage;
      this._sendError(err, errorMessage);
      await this._hideLoadingScreen();
      return;
    }
    let connection;
    try {
      connection = await createConnection({ auth });
    } catch (err: any) {
      const errorMessage = this._getErrorMessage(err);
      this._error = errorMessage;
      this._sendError(err, errorMessage);
      await this._hideLoadingScreen();
      return;
    }
    if (this.hass) {
      this.hass.connection.close();
    }
    this.initializeHass(auth, connection);
    if (this._hassUUID !== msg.hassUUID) {
      this._configGeneration += 1;
      this._hassUUID = msg.hassUUID;
      this._lovelaceConfig = undefined;
      this._urlPath = undefined;
      this._lovelacePath = null;
      this._dashboardLoaded = false;
      if (this._unsubLovelace) {
        this._unsubLovelace();
        this._unsubLovelace = undefined;
      }
      resourcesLoaded = false;
    }
    this._error = undefined;
    this._sendStatus();
  }

  private async _handleShowLovelaceMessage(msg: ShowLovelaceViewMessage) {
    // We should not get this command before we are connected.
    // Means a client got out of sync. Let's send status to them.
    if (!this.hass?.connected) {
      this._sendStatus(msg.senderId!);
      this._error = "Cannot show Lovelace because we're not connected.";
      this._sendError(
        ReceiverErrorCode.NOT_CONNECTED,
        this._error,
        msg.senderId!
      );
      await this._hideLoadingScreen();
      return;
    }

    if (
      (msg.hassUUID && msg.hassUUID !== this._hassUUID) ||
      (msg.hassUrl && msg.hassUrl !== this.hass.auth.data.hassUrl)
    ) {
      this._sendStatus(msg.senderId!);
      this._error =
        "Cannot show Lovelace because we're not connected to the same Home Assistant instance.";
      this._sendError(
        ReceiverErrorCode.WRONG_INSTANCE,
        this._error,
        msg.senderId!
      );
      await this._hideLoadingScreen();
      return;
    }

    if (msg.urlPath === "lovelace" || msg.urlPath === undefined) {
      msg.urlPath = null;
    }
    const generation = ++this._loadGeneration;
    const viewGeneration = this._viewGeneration + 1;
    this._expectedViewGeneration = viewGeneration;
    this._pendingViewOperationId = msg.operationId;
    const covered = await this._showLoadingScreen(false);
    if (!covered || generation !== this._loadGeneration) {
      return;
    }

    this._showDemo = false;
    this._error = undefined;
    this._dashboardLoaded = false;
    window.blueHouseCastLoadingScreen?.setPhase("mounting");
    this._vignetteSize =
      typeof msg.vignetteSize === "number" && Number.isFinite(msg.vignetteSize)
        ? Math.max(0, Math.round(msg.vignetteSize))
        : 0;
    this._viewGeneration = viewGeneration;
    this._lovelacePath = msg.viewPath;
    if (msg.urlPath === "energy") {
      this._configGeneration += 1;
      this._unsubLovelace?.();
      this._unsubLovelace = undefined;
      this._lovelaceConfig = {
        views: [
          {
            strategy: {
              type: "energy",
            },
          },
        ],
      };
      this._urlPath = "energy";
      this._lovelacePath = null;
      this._sendStatus();
      return;
    }
    if (!this._unsubLovelace || this._urlPath !== msg.urlPath) {
      const configGeneration = ++this._configGeneration;
      this._urlPath = msg.urlPath;
      this._lovelaceConfig = undefined;
      this._dashboardLoaded = false;
      if (this._unsubLovelace) {
        this._unsubLovelace();
        this._unsubLovelace = undefined;
      }
      await this.updateComplete;
      if (generation !== this._loadGeneration) {
        return;
      }
      const llColl = atLeastVersion(this.hass.connection.haVersion, 0, 107)
        ? getLovelaceCollection(this.hass.connection, msg.urlPath)
        : getLegacyLovelaceCollection(this.hass.connection);
      // We first do a single refresh because we need to check if there is LL
      // configuration.
      try {
        await llColl.refresh();
        if (generation !== this._loadGeneration) {
          return;
        }
        this._unsubLovelace = llColl.subscribe(async (rawConfig) => {
          if (isStrategyDashboard(rawConfig)) {
            const { generateLovelaceDashboardStrategy } =
              await import("../../../../src/panels/lovelace/strategies/get-strategy");
            const config = await generateLovelaceDashboardStrategy(
              rawConfig,
              this.hass!
            );
            if (configGeneration === this._configGeneration) {
              this._handleNewLovelaceConfig(config);
            }
          } else if (configGeneration === this._configGeneration) {
            this._handleNewLovelaceConfig(rawConfig);
          }
        });
      } catch (err: any) {
        if (generation !== this._loadGeneration) {
          return;
        }
        if (
          atLeastVersion(this.hass.connection.haVersion, 0, 107) &&
          err.code !== "config_not_found"
        ) {
          // eslint-disable-next-line
          console.log("Error fetching Lovelace configuration", err, msg);
          this._error = `Error fetching Lovelace configuration: ${err.message}`;
          this._sendError(ReceiverErrorCode.FETCH_CONFIG_FAILED, this._error);
          await this._hideLoadingScreen();
          return;
        }
        // Generate a Lovelace config.
        this._unsubLovelace = () => undefined;
        await this._generateDefaultLovelaceConfig();
      }
    }
    if (!resourcesLoaded) {
      resourcesLoaded = true;
      const resources = atLeastVersion(this.hass.connection.haVersion, 0, 107)
        ? await fetchResources(this.hass!.connection)
        : (this._lovelaceConfig as LegacyLovelaceConfig).resources;
      if (resources) {
        loadLovelaceResources(resources, this.hass!);
      }
    }

    if (generation !== this._loadGeneration) {
      return;
    }
    this._sendStatus();
  }

  private async _generateDefaultLovelaceConfig() {
    const generation = this._configGeneration;
    const { generateLovelaceDashboardStrategy } =
      await import("../../../../src/panels/lovelace/strategies/get-strategy");
    const config = await generateLovelaceDashboardStrategy(
      DEFAULT_CONFIG,
      this.hass!
    );
    if (generation === this._configGeneration) {
      this._handleNewLovelaceConfig(config);
    }
  }

  private _handleNewLovelaceConfig(lovelaceConfig: LovelaceConfig) {
    const title = getPanelTitleFromUrlPath(
      this.hass!,
      this._urlPath || "lovelace"
    );
    castContext.setApplicationState(title || "");
    this._lovelaceConfig = checkLovelaceConfig(
      lovelaceConfig
    ) as LovelaceConfig;
    void this.updateComplete.then(() => this._sendStatus());
  }

  private _handleShowDemo(_msg: ShowDemoMessage) {
    void this._showDemoView();
  }

  private async _showDemoView() {
    const generation = ++this._loadGeneration;
    this._pendingViewOperationId = undefined;
    this._expectedViewGeneration = -1;
    await this._showLoadingScreen(false);
    if (generation !== this._loadGeneration) {
      return;
    }
    await import("./hc-demo");
    if (generation !== this._loadGeneration) {
      return;
    }
    this._dashboardLoaded = false;
    this._showDemo = true;
    this._lovelacePath = "overview";
    await this.updateComplete;
    window.blueHouseCastLoadingScreen?.scheduleReveal();
    this._sendStatus();
  }

  private async _handleShowLoadingScreen(msg: ShowLoadingScreenMessage) {
    const generation = ++this._loadGeneration;
    this._pendingViewOperationId = undefined;
    this._expectedViewGeneration = this._viewGeneration;
    if (
      (await this._showLoadingScreen(true)) &&
      generation === this._loadGeneration
    ) {
      this._completedOperationId = msg.operationId;
      this._sendStatus();
    }
  }

  private async _handleHideLoadingScreen(msg: HideLoadingScreenMessage) {
    const generation = ++this._loadGeneration;
    this._pendingViewOperationId = undefined;
    this._expectedViewGeneration = this._viewGeneration;
    if (
      (await this._hideLoadingScreen()) &&
      generation === this._loadGeneration
    ) {
      this._completedOperationId = msg.operationId;
      this._sendStatus();
    }
  }

  private async _handleUnloadDashboard(msg: UnloadDashboardMessage) {
    const generation = ++this._loadGeneration;
    this._pendingViewOperationId = undefined;
    this._expectedViewGeneration = -1;
    const covered = await this._showLoadingScreen(true);
    if (!covered || generation !== this._loadGeneration) {
      return;
    }
    this._configGeneration += 1;
    this._vignetteSize = 0;
    this._showDemo = false;
    this._dashboardLoaded = false;
    this._error = undefined;
    this._lovelaceConfig = undefined;
    this._urlPath = undefined;
    this._lovelacePath = null;
    if (this._unsubLovelace) {
      this._unsubLovelace();
      this._unsubLovelace = undefined;
    }
    await this.updateComplete;
    if (generation !== this._loadGeneration) return;
    window.blueHouseCastLoadingScreen?.setPhase("unloaded");
    this._completedOperationId = msg.operationId;
    this._sendStatus();
  }

  private async _showLoadingScreen(hold: boolean) {
    const loadingScreen = window.blueHouseCastLoadingScreen;
    if (!loadingScreen) {
      throw new Error("The receiver loading screen is unavailable.");
    }
    const completed = await loadingScreen.show(hold);
    if (completed) {
      // Paint the opaque cover before dashboard teardown and mounting work.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      this._loadingScreenVisible = true;
      this._sendStatus();
    }
    return completed;
  }

  private async _hideLoadingScreen() {
    const loadingScreen = window.blueHouseCastLoadingScreen;
    if (!loadingScreen) {
      throw new Error("The receiver loading screen is unavailable.");
    }
    const completed = await loadingScreen.hide();
    if (completed) {
      this._loadingScreenVisible = false;
      this._sendStatus();
    }
    return completed;
  }

  private _handleCastViewChanged = (ev: HASSDomEvent<CastViewChanged>) => {
    if (
      ev.detail.renderGeneration !== this._expectedViewGeneration ||
      !isRequestedLovelaceViewReady(
        this._lovelaceConfig?.views,
        this._urlPath,
        this._lovelacePath,
        !!this.hass?.connected
      )
    ) {
      return;
    }
    this._dashboardLoaded = true;
    window.blueHouseCastLoadingScreen?.setPhase("mounted");
    this._sendStatus();
    window.blueHouseCastLoadingScreen?.scheduleReveal();
  };

  private _getErrorMessage(error: number): string {
    switch (error) {
      case 1:
        return "Unable to connect to the Home Assistant websocket API.";
      case 2:
        return "The supplied authentication is invalid.";
      case 3:
        return "The connection to Home Assistant was lost.";
      case 4:
        return "Missing hassUrl. This is required.";
      case 5:
        return "Home Assistant needs to be served over https:// to use with Home Assistant Cast.";
      default:
        return "Unknown Error";
    }
  }

  private _sendMessage(senderId: string, response: any) {
    castContext.sendCustomMessage(CAST_NS, senderId, response);
  }
}

declare global {
  interface Window {
    blueHouseCastLoadingScreen?: ReceiverLoadingScreen;
  }
  interface HTMLElementTagNameMap {
    "hc-main": HcMain;
  }
}
