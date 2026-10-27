import type { Connection, UnsubscribeFunc } from "home-assistant-js-websocket";
import { createConnection, getAuth } from "home-assistant-js-websocket";
import type { TemplateResult, PropertyValues } from "lit";
import { css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators";
import { keyed } from "lit/directives/keyed";
import { CAST_NS } from "../../../../src/cast/const";
import type {
  ApplySettingsMessage,
  ConnectMessage,
  GetStatusMessage,
  HassMessage,
  HideLoadingScreenMessage,
  SetBrightnessMessage,
  ShowDemoMessage,
  ShowLovelaceViewMessage,
  ShowLoadingScreenMessage,
  ReceiverControlMessage,
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
  LovelaceRawConfig,
} from "../../../../src/data/lovelace/config/types";
import {
  fetchConfig,
  isStrategyDashboard,
} from "../../../../src/data/lovelace/config/types";
import { fetchResources } from "../../../../src/data/lovelace/resource";
import { loadLovelaceResources } from "../../../../src/panels/lovelace/common/load-resources";
import { HassElement } from "../../../../src/state/hass-element";
import { castContext } from "../cast_context";
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
  coverImmediately(): void;
  setPhase(phase: "startup" | "mounting" | "mounted" | "unloaded"): void;
  getPerformance(): LoadingPerformance;
  setBrightness(value: number): Promise<boolean>;
  getBrightness(): number;
  setDesktop(desktop: "particles" | "black", settingsVersion: number): boolean;
  getDesktop(): "particles" | "black";
  getVignette(): number;
  getSettingsVersion(): number;
  setVignette(size: number): boolean;
  subscribe(listener: (visible: boolean) => void): () => void;
}

@customElement("hc-main")
export class HcMain extends HassElement {
  @state() private _showDemo = false;

  @state() private _loadingScreenVisible = true;

  @state() private _dashboardLoaded = false;

  @state() private _viewGeneration = 0;

  @state() private _vignetteSize = 0;

  @state() private _desktop: "particles" | "black" = "particles";

  private _brightnessPct = 100;

  static styles = css`
    .error-frame {
      position: fixed;
      inset: 12px;
      z-index: 2147483645;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      padding: 24px;
      border: 3px solid #d32f2f;
      box-sizing: border-box;
      pointer-events: none;
      color: #fff;
      font-size: 18px;
      text-align: center;
      text-shadow: 0 1px 4px #000;
      animation: error-shimmer 1.2s ease-in-out infinite alternate;
    }

    @keyframes error-shimmer {
      from {
        border-color: #9c1717;
      }
      to {
        border-color: #ff5252;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .error-frame {
        animation: none;
      }
    }
  `;

  @state() private _lovelaceConfig?: LovelaceConfig;

  @state() private _lovelacePath: string | number | null = null;

  @state() private _urlPath?: string | null;

  @state() private _error?: string;

  @state() private _errorNoticeVisible = false;

  private _mountTimer?: number;

  private _errorNoticeTimer?: number;

  private _errorNoticeRemaining = 5000;

  private _hassUUID?: string;

  private _unsubLovelace?: UnsubscribeFunc;

  private _statusConnection?: Connection;

  private _handleDataConnectionChange = () => this._sendStatus();

  private _unsubLoadingScreen?: () => void;

  private _loadGeneration = 0;

  private _configGeneration = 0;

  private _expectedViewGeneration = 0;

  private _pendingViewOperationId?: string;

  private _completedOperationId?: string;

  private _lastRequestId?: string;

  private _lastCommand?: string;

  private _commandOutcome?: string;

  private _commandError?: string;

  private _commandStartedAt?: number;

  private _commandUpdatedAt?: number;

  private _selectedContent?: ShowLovelaceViewMessage;

  private _desiredVisible = true;

  private _suspended = false;

  private _contentPhase: NonNullable<ReceiverStatusMessage["contentPhase"]> =
    "idle";

  private readonly _sessionId = crypto.randomUUID();

  private _handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      window.clearTimeout(this._errorNoticeTimer);
      this._errorNoticeTimer = undefined;
      void this._suspendContent();
    } else if (document.visibilityState === "visible" && this._suspended) {
      void this._restoreSuspendedContent();
    } else if (
      document.visibilityState === "visible" &&
      this._errorNoticeVisible
    ) {
      this._startErrorNoticeTimer();
    }
    this._sendStatus();
  };

  public connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._handleVisibilityChange);
    this.addEventListener("cast-view-changed", this._handleCastViewChanged);
    this._unsubLoadingScreen = window.blueHouseCastLoadingScreen?.subscribe(
      (visible) => {
        this._loadingScreenVisible = visible;
        if (!visible && this._dashboardLoaded) {
          this._contentPhase = "displayed";
          this._commandOutcome = "displayed";
          this._commandUpdatedAt = Date.now();
        }
        if (!visible && this._dashboardLoaded && this._pendingViewOperationId) {
          this._completedOperationId = this._pendingViewOperationId;
          this._pendingViewOperationId = undefined;
        }
        queueMicrotask(() => this._sendStatus());
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
    this._statusConnection?.removeEventListener(
      "disconnected",
      this._handleDataConnectionChange
    );
    this._statusConnection?.removeEventListener(
      "ready",
      this._handleDataConnectionChange
    );
    this._statusConnection = undefined;
    window.clearTimeout(this._mountTimer);
    window.clearTimeout(this._errorNoticeTimer);
    super.disconnectedCallback();
  }

  public processIncomingMessage(msg: HassMessage) {
    if (
      "protocolVersion" in msg &&
      msg.protocolVersion !== undefined &&
      msg.protocolVersion !== 1
    ) {
      this._rejectMessage(msg, "Receiver protocol version mismatch.");
      return;
    }
    if (
      "sessionId" in msg &&
      msg.sessionId &&
      msg.sessionId !== this._sessionId
    ) {
      this._rejectMessage(msg, "Receiver session has changed.");
      return;
    }
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
    } else if (msg.type === "set_brightness") {
      this._handleSetBrightness(msg);
    } else if (msg.type === "apply_settings") {
      this._handleApplySettings(msg);
    } else if (msg.type === "show_content") {
      this._handleHideLoadingScreen(msg);
    } else if (msg.type === "hide_content") {
      this._handleShowLoadingScreen(msg);
    } else if (msg.type === "unload_content") {
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
        return this._errorNoticeVisible ? this._renderErrorNotice() : nothing;
      }
      return this._errorNoticeVisible ? this._renderErrorNotice() : nothing;
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
    )}`;
  }

  protected firstUpdated(changedProps: PropertyValues<this>) {
    super.firstUpdated(changedProps);
    this._desktop =
      window.blueHouseCastLoadingScreen?.getDesktop() ?? "particles";
    this._brightnessPct =
      window.blueHouseCastLoadingScreen?.getBrightness() ?? 100;
    this._vignetteSize = window.blueHouseCastLoadingScreen?.getVignette() ?? 0;
    window.blueHouseCastLoadingScreen?.setVignette(this._vignetteSize);
    this._sendStatus();
    import("./hc-lovelace");
    import("../../../../src/resources/append-ha-style");

    window.addEventListener("location-changed", () => {
      const panelPath = `/${this._urlPath || "lovelace"}/`;
      if (location.pathname.startsWith(panelPath)) {
        this._lovelacePath = location.pathname.substr(panelPath.length);
        this._rememberSelectedPath();
        this._dashboardLoaded = false;
        this._sendStatus();
      }
    });
    document.body.addEventListener("click", (ev) => {
      const panelPath = `/${this._urlPath || "lovelace"}/`;
      const href = isNavigationClick(ev);
      if (href && href.startsWith(panelPath)) {
        this._lovelacePath = href.substr(panelPath.length);
        this._rememberSelectedPath();
        this._dashboardLoaded = false;
        this._sendStatus();
      }
    });
    this.addEventListener("dialog-closed", this._dialogClosed);
  }

  protected updated(changedProps: PropertyValues<this>) {
    super.updated(changedProps);
    if (
      changedProps.has("hass") &&
      this.hass?.connection !== this._statusConnection
    ) {
      this._statusConnection?.removeEventListener(
        "disconnected",
        this._handleDataConnectionChange
      );
      this._statusConnection?.removeEventListener(
        "ready",
        this._handleDataConnectionChange
      );
      this._statusConnection = this.hass?.connection;
      this._statusConnection?.addEventListener(
        "disconnected",
        this._handleDataConnectionChange
      );
      this._statusConnection?.addEventListener(
        "ready",
        this._handleDataConnectionChange
      );
      this._sendStatus();
    }
  }

  private _sendStatus(senderId?: string) {
    const status: ReceiverStatusMessage = {
      type: "receiver_status",
      protocolVersion: 1,
      sessionId: this._sessionId,
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
      contentLoaded: this._dashboardLoaded,
      contentVisible:
        this._dashboardLoaded &&
        !this._loadingScreenVisible &&
        document.visibilityState === "visible",
      contentPhase: this._suspended ? "suspended" : this._contentPhase,
      desiredVisible: this._desiredVisible,
      desktop: this._desktop,
      settingsVersion: window.blueHouseCastLoadingScreen?.getSettingsVersion(),
      vignetteSize: this._vignetteSize,
      brightnessPct: this._brightnessPct,
      loadingPerformance: window.blueHouseCastLoadingScreen?.getPerformance(),
      completedOperationId: this._completedOperationId,
      lastRequestId: this._lastRequestId,
      lastCommand: this._lastCommand,
      commandOutcome: this._commandOutcome,
      commandError: this._commandError,
      commandStartedAt: this._commandStartedAt,
      commandUpdatedAt: this._commandUpdatedAt,
    };

    if (this.hass) {
      status.hassUrl = this.hass.auth.data.hassUrl;
      status.hassUUID = this._hassUUID;
      status.lovelacePath = this._suspended
        ? this._selectedContent?.viewPath
        : this._lovelacePath;
      status.urlPath = this._suspended
        ? this._selectedContent?.urlPath
        : this._urlPath;
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
    if (msg.protocolVersion !== undefined && msg.protocolVersion !== 1) {
      this._error = "Receiver protocol version mismatch.";
      this._sendError(
        ReceiverErrorCode.PROTOCOL_MISMATCH,
        this._error,
        msg.senderId
      );
      return;
    }
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
      this._rejectMessage(
        msg,
        "Cannot show Lovelace because Home Assistant data is disconnected."
      );
      return;
    }

    if (
      (msg.hassUUID && msg.hassUUID !== this._hassUUID) ||
      (msg.hassUrl && msg.hassUrl !== this.hass.auth.data.hassUrl)
    ) {
      this._sendStatus(msg.senderId!);
      this._rejectMessage(
        msg,
        "Cannot show Lovelace because this receiver is connected to a different Home Assistant instance."
      );
      return;
    }

    if (
      !(typeof msg.viewPath === "string" || typeof msg.viewPath === "number") ||
      !(msg.urlPath === null || typeof msg.urlPath === "string")
    ) {
      this._rejectMessage(msg, "A valid dashboard and view path are required.");
      return;
    }
    if (
      (msg.brightnessPct !== undefined &&
        (!Number.isInteger(msg.brightnessPct) ||
          msg.brightnessPct < 0 ||
          msg.brightnessPct > 100)) ||
      (msg.vignetteSize !== undefined &&
        (!Number.isInteger(msg.vignetteSize) || msg.vignetteSize < 0)) ||
      (msg.settingsVersion !== undefined &&
        (!Number.isInteger(msg.settingsVersion) ||
          msg.settingsVersion <
            (window.blueHouseCastLoadingScreen?.getSettingsVersion() ?? 0))) ||
      (msg.keepAlive !== undefined && typeof msg.keepAlive !== "boolean")
    ) {
      this._rejectMessage(msg, "Invalid or stale receiver settings.");
      return;
    }

    if (msg.urlPath === "lovelace" || msg.urlPath === undefined) {
      msg.urlPath = null;
    }
    let validationTimer = 0;
    try {
      await Promise.race([
        this._validateRequestedView(msg),
        new Promise<never>((_resolve, reject) => {
          validationTimer = window.setTimeout(
            () =>
              reject(
                new Error("Home Assistant dashboard data readiness timed out.")
              ),
            30000
          );
        }),
      ]);
    } catch (err: any) {
      this._rejectMessage(
        msg,
        `The requested dashboard view is unavailable: ${err?.message || err}`
      );
      return;
    } finally {
      window.clearTimeout(validationTimer);
    }
    if (!msg.internalRestore) {
      this._selectedContent = { ...msg };
      this._desiredVisible = true;
    } else {
      this._commandOutcome = "restoring";
      this._commandStartedAt = Date.now();
      this._commandUpdatedAt = this._commandStartedAt;
    }
    if (document.visibilityState === "hidden") {
      this._suspended = true;
      this._contentPhase = "suspended";
      if (!msg.internalRestore) this._sendAcceptance(msg);
      this._sendStatus(msg.senderId);
      return;
    }
    const generation = ++this._loadGeneration;
    this._contentPhase = "loading";
    window.clearTimeout(this._mountTimer);
    const viewGeneration = this._viewGeneration + 1;
    this._expectedViewGeneration = viewGeneration;
    this._pendingViewOperationId = msg.operationId;
    if (!msg.internalRestore) this._sendAcceptance(msg);
    const coverTransition = this._showLoadingScreen(false);
    const brightnessTransition =
      msg.brightnessPct === undefined
        ? Promise.resolve(true)
        : this._setBrightness(msg.brightnessPct);
    const [covered, brightnessChanged] = await Promise.all([
      coverTransition,
      brightnessTransition,
    ]);
    if (!covered || !brightnessChanged || generation !== this._loadGeneration) {
      return;
    }
    this._mountTimer = window.setTimeout(
      () =>
        void this._failMount(
          generation,
          "The dashboard did not finish loading within 30 seconds."
        ),
      30000
    );

    this._showDemo = false;
    this._error = undefined;
    this._dashboardLoaded = false;
    window.blueHouseCastLoadingScreen?.setPhase("mounting");
    this._vignetteSize =
      typeof msg.vignetteSize === "number" && Number.isFinite(msg.vignetteSize)
        ? Math.max(0, Math.round(msg.vignetteSize))
        : 0;
    window.blueHouseCastLoadingScreen?.setVignette(this._vignetteSize);
    if (msg.settingsVersion !== undefined) {
      const layer = window.blueHouseCastLoadingScreen;
      if (layer?.setDesktop(this._desktop, msg.settingsVersion)) {
        try {
          localStorage.setItem(
            "blue-house-cast-settings-v1",
            JSON.stringify({
              desktop: this._desktop,
              settingsVersion: msg.settingsVersion,
              brightnessPct: this._brightnessPct,
              vignetteSize: this._vignetteSize,
              keepAlive: msg.keepAlive ?? true,
            })
          );
        } catch {
          // Home Assistant remains the durable settings owner.
        }
      }
    }
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
          await this._failMount(generation, this._error);
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

  private async _validateRequestedView(msg: ShowLovelaceViewMessage) {
    if (!this.hass?.connected) {
      throw new Error("Home Assistant data is not connected.");
    }
    if (msg.urlPath === "energy") {
      const energyConfig: LovelaceConfig = {
        views: [{ strategy: { type: "energy" } }],
      };
      if (
        !isRequestedLovelaceViewReady(
          energyConfig.views,
          msg.urlPath,
          null,
          true
        )
      ) {
        throw new Error("The energy dashboard has no requested view.");
      }
      return;
    }
    let rawConfig: LovelaceRawConfig;
    try {
      rawConfig = await fetchConfig(this.hass.connection, msg.urlPath, false);
    } catch (err: any) {
      if (msg.urlPath !== null || err?.code !== "config_not_found") throw err;
      rawConfig = DEFAULT_CONFIG;
    }
    const config = isStrategyDashboard(rawConfig)
      ? await (
          await import("../../../../src/panels/lovelace/strategies/get-strategy")
        ).generateLovelaceDashboardStrategy(rawConfig, this.hass!)
      : (rawConfig as LovelaceConfig);
    const checked = checkLovelaceConfig(config) as LovelaceConfig;
    if (
      !isRequestedLovelaceViewReady(
        checked.views,
        msg.urlPath,
        msg.viewPath,
        true
      )
    ) {
      throw new Error("The dashboard does not contain that view path.");
    }
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

  private async _handleShowLoadingScreen(
    msg: ShowLoadingScreenMessage | ReceiverControlMessage
  ) {
    this._desiredVisible = false;
    if (this._suspended || document.visibilityState === "hidden") {
      this._ackControl(msg as ReceiverControlMessage, "hide_content");
      this._commandOutcome = "hidden";
      this._sendStatus(msg.senderId);
      return;
    }
    if (!this._dashboardLoaded) {
      this._ackControl(msg as ReceiverControlMessage, "hide_content");
      this._sendStatus(msg.senderId);
      return;
    }
    if (await this._showLoadingScreen(true)) {
      this._completedOperationId =
        "operationId" in msg ? msg.operationId : undefined;
      this._ackControl(msg as ReceiverControlMessage, "hide_content");
      this._commandOutcome = "hidden";
      this._sendStatus();
    }
  }

  private async _handleSetBrightness(msg: SetBrightnessMessage) {
    if (await this._setBrightness(msg.brightnessPct)) {
      this._completedOperationId = msg.operationId;
      this._sendStatus();
    }
  }

  private async _handleApplySettings(msg: ApplySettingsMessage) {
    const layer = window.blueHouseCastLoadingScreen;
    if (!layer || msg.protocolVersion !== 1) return;
    if (msg.settingsVersion < layer.getSettingsVersion()) {
      this._sendRequestAck(
        msg,
        "apply_settings",
        "rejected",
        "Stale settings version."
      );
      this._sendStatus(msg.senderId);
      return;
    }
    const valid =
      (msg.desktop === "particles" || msg.desktop === "black") &&
      Number.isInteger(msg.brightnessPct) &&
      msg.brightnessPct >= 0 &&
      msg.brightnessPct <= 100 &&
      Number.isInteger(msg.vignetteSize) &&
      msg.vignetteSize >= 0 &&
      Number.isInteger(msg.settingsVersion) &&
      typeof msg.keepAlive === "boolean";
    if (!valid) {
      this._sendRequestAck(
        msg,
        "apply_settings",
        "rejected",
        "Invalid receiver settings."
      );
      return;
    }
    if (!(await this._setBrightness(msg.brightnessPct))) {
      this._sendRequestAck(
        msg,
        "apply_settings",
        "rejected",
        "Brightness could not be applied."
      );
      return;
    }
    if (!layer.setDesktop(msg.desktop, msg.settingsVersion)) return;
    this._desktop = msg.desktop;
    this._vignetteSize = msg.vignetteSize;
    layer.setVignette(msg.vignetteSize);
    try {
      localStorage.setItem(
        "blue-house-cast-settings-v1",
        JSON.stringify({
          desktop: msg.desktop,
          settingsVersion: msg.settingsVersion,
          brightnessPct: msg.brightnessPct,
          vignetteSize: msg.vignetteSize,
          keepAlive: msg.keepAlive,
        })
      );
    } catch {
      // Settings remain durable in Home Assistant if browser storage is full.
    }
    this._sendRequestAck(msg, "apply_settings", "accepted");
    this._sendStatus(msg.senderId);
  }

  private async _setBrightness(value: number) {
    const loadingScreen = window.blueHouseCastLoadingScreen;
    if (!loadingScreen) {
      throw new Error("The receiver brightness layer is unavailable.");
    }
    const completed = await loadingScreen.setBrightness(value);
    if (completed) {
      this._brightnessPct = loadingScreen.getBrightness();
      this._sendStatus();
    }
    return completed;
  }

  private async _handleHideLoadingScreen(
    msg: HideLoadingScreenMessage | ReceiverControlMessage
  ) {
    this._desiredVisible = true;
    if (!this._selectedContent) {
      this._sendRequestAck(
        msg,
        "show_content",
        "rejected",
        "There is no selected dashboard view to show."
      );
      this._sendError(
        ReceiverErrorCode.NOT_CONNECTED,
        "There is no selected dashboard view to show.",
        msg.senderId
      );
      return;
    }
    if (this._suspended) {
      this._ackControl(msg as ReceiverControlMessage, "show_content");
      this._sendStatus(msg.senderId);
      return;
    }
    if (!this._dashboardLoaded) {
      this._ackControl(msg as ReceiverControlMessage, "show_content");
      this._sendStatus(msg.senderId);
      return;
    }
    if (await this._hideLoadingScreen()) {
      this._completedOperationId =
        "operationId" in msg ? msg.operationId : undefined;
      this._ackControl(msg as ReceiverControlMessage, "show_content");
      this._sendStatus();
    }
  }

  private async _handleUnloadDashboard(
    msg: UnloadDashboardMessage | ReceiverControlMessage
  ) {
    const wasSuspended = this._suspended;
    this._selectedContent = undefined;
    this._desiredVisible = false;
    this._suspended = false;
    this._contentPhase = "unloaded";
    const generation = ++this._loadGeneration;
    this._pendingViewOperationId = undefined;
    this._expectedViewGeneration = -1;
    const hidden = wasSuspended || document.visibilityState === "hidden";
    if (hidden) window.blueHouseCastLoadingScreen?.coverImmediately();
    const covered = hidden || (await this._showLoadingScreen(true));
    if (!covered || generation !== this._loadGeneration) {
      return;
    }
    this._configGeneration += 1;
    this._showDemo = false;
    this._dashboardLoaded = false;
    this._error = undefined;
    this._errorNoticeVisible = false;
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
    this._completedOperationId =
      "operationId" in msg ? msg.operationId : undefined;
    this._ackControl(msg as ReceiverControlMessage, "unload_content");
    this._commandOutcome = "unloaded";
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

  private async _suspendContent() {
    if (this._suspended || !this._selectedContent) return;
    this._suspended = true;
    this._contentPhase = "suspended";
    ++this._loadGeneration;
    ++this._configGeneration;
    window.blueHouseCastLoadingScreen?.coverImmediately();
    this._loadingScreenVisible = true;
    this._dashboardLoaded = false;
    this._showDemo = false;
    this._lovelaceConfig = undefined;
    this._urlPath = undefined;
    this._unsubLovelace?.();
    this._unsubLovelace = undefined;
    await this.updateComplete;
    this._sendStatus();
  }

  private async _restoreSuspendedContent() {
    const selection = this._selectedContent;
    if (!selection || !this._suspended) return;
    this._suspended = false;
    await this._handleShowLovelaceMessage({
      ...selection,
      senderId: undefined,
      internalRestore: true,
    });
  }

  private _sendAcceptance(msg: ShowLovelaceViewMessage) {
    if (!msg.requestId || !msg.senderId) return;
    this._lastRequestId = msg.requestId;
    this._lastCommand = "show_lovelace";
    this._commandOutcome = "accepted";
    this._commandError = undefined;
    this._commandStartedAt = Date.now();
    this._commandUpdatedAt = this._commandStartedAt;
    this._sendMessage(msg.senderId, {
      type: "command_ack",
      protocolVersion: 1,
      sessionId: msg.sessionId,
      requestId: msg.requestId,
      command: "show_lovelace",
      outcome: "accepted",
      startedAt: this._commandStartedAt,
      updatedAt: this._commandUpdatedAt,
    });
  }

  private _rejectMessage(msg: HassMessage, error: string) {
    if (!("requestId" in msg) || !msg.requestId || !msg.senderId) return;
    this._sendMessage(msg.senderId, {
      type: "command_ack",
      protocolVersion: 1,
      sessionId: this._sessionId,
      requestId: msg.requestId,
      command: msg.type,
      outcome: "rejected",
      error,
    });
  }

  private _ackControl(msg: ReceiverControlMessage, command: string) {
    this._sendRequestAck(msg, command, "accepted");
  }

  private _sendRequestAck(
    msg: { senderId?: string; requestId?: string; sessionId?: string },
    command: string,
    outcome: "accepted" | "rejected",
    error?: string
  ) {
    if (!msg.requestId || !msg.sessionId || !msg.senderId) return;
    this._lastRequestId = msg.requestId;
    this._lastCommand = command;
    this._commandOutcome = outcome;
    this._commandError = error;
    this._commandStartedAt = Date.now();
    this._commandUpdatedAt = this._commandStartedAt;
    this._sendMessage(msg.senderId, {
      type: "command_ack",
      protocolVersion: 1,
      sessionId: msg.sessionId,
      requestId: msg.requestId,
      command,
      outcome,
      error,
      startedAt: this._commandStartedAt,
      updatedAt: this._commandUpdatedAt,
    });
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
    window.clearTimeout(this._mountTimer);
    this._mountTimer = undefined;
    if (this._selectedContent) {
      this._selectedContent = {
        ...this._selectedContent,
        urlPath: this._urlPath ?? null,
        viewPath: this._lovelacePath,
      };
    }
    this._dashboardLoaded = true;
    this._contentPhase = "mounted";
    this._commandOutcome = "mounted";
    this._commandUpdatedAt = Date.now();
    window.blueHouseCastLoadingScreen?.setPhase("mounted");
    this._sendStatus();
    if (this._desiredVisible) {
      window.blueHouseCastLoadingScreen?.scheduleReveal();
    }
  };

  private _rememberSelectedPath() {
    if (!this._selectedContent) return;
    this._selectedContent = {
      ...this._selectedContent,
      urlPath: this._urlPath ?? null,
      viewPath: this._lovelacePath,
    };
  }

  private async _failMount(generation: number, message: string) {
    if (generation !== this._loadGeneration || this._suspended) return;
    ++this._loadGeneration;
    ++this._configGeneration;
    this._mountTimer = undefined;
    this._contentPhase = "failed";
    this._commandOutcome = "failed";
    this._commandError = message;
    this._commandUpdatedAt = Date.now();
    this._error = message;
    this._selectedContent = undefined;
    this._desiredVisible = false;
    this._dashboardLoaded = false;
    this._lovelaceConfig = undefined;
    this._urlPath = undefined;
    this._unsubLovelace?.();
    this._unsubLovelace = undefined;
    this._errorNoticeRemaining = 5000;
    this._errorNoticeVisible = true;
    await this.updateComplete;
    await this._hideLoadingScreen();
    this._startErrorNoticeTimer();
    this._sendStatus();
  }

  private _renderErrorNotice() {
    return html`<div class="error-frame" role="status">
      <span>${this._error}</span>
    </div>`;
  }

  private _startErrorNoticeTimer() {
    if (document.visibilityState !== "visible" || !this._errorNoticeVisible) {
      return;
    }
    window.clearTimeout(this._errorNoticeTimer);
    const started = performance.now();
    this._errorNoticeTimer = window.setTimeout(
      () => {
        this._errorNoticeRemaining = Math.max(
          0,
          this._errorNoticeRemaining - (performance.now() - started)
        );
        if (this._errorNoticeRemaining <= 0) {
          this._errorNoticeVisible = false;
          this._errorNoticeTimer = undefined;
          return;
        }
        this._startErrorNoticeTimer();
      },
      Math.min(250, this._errorNoticeRemaining)
    );
  }

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
