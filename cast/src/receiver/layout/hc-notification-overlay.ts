import type { TemplateResult } from "lit";
import { css, html, LitElement, nothing } from "lit";
import { customElement, query, state } from "lit/decorators";
import { styleMap } from "lit/directives/style-map";
import type {
  NotificationPhase,
  NotificationProfile,
  ReceiverNotification,
} from "../notifications";

const COLORS = {
  routine: "145,202,250",
  notice: "245,186,120",
  important: "255,152,95",
  emergency: "255,104,119",
} as const;

const STYLE_ELEMENT_ID = "hc-notification-overlay-styles";

interface Spark {
  position: number;
  age: number;
  life: number;
  speed: number;
  side: number;
  size: number;
}

const EDGE_LIMIT = 175;
const BURST_LIMIT = 250;

@customElement("hc-notification-overlay")
export class HcNotificationOverlay extends LitElement {
  @state() private _notification?: ReceiverNotification;

  @state() private _phase?: NotificationPhase;

  @state() private _entered = false;

  private _profile?: NotificationProfile;

  private _sparkSprites = new Map<
    keyof typeof COLORS,
    HTMLCanvasElement | null
  >();

  @query(".sparks")
  private _canvas?: HTMLCanvasElement;

  @query(".card")
  private _card?: HTMLElement;

  @query(".measure")
  private _measure?: HTMLElement;

  private _context?: CanvasRenderingContext2D | null;

  private _textMeter?: CanvasRenderingContext2D | null;

  private _resizeObserver?: ResizeObserver;

  private _frame?: number;

  private _dismissTimer?: number;

  private _lastPaint = 0;

  private _phaseStarted = 0;

  private _lastTick = 0;

  private _edgeSparks: Spark[] = [];

  private _burstSparks: Spark[] = [];

  private _spawnAccumulator = 0;

  private _cardWidth = 0;

  private _cardHeight = 0;

  private _runId = 0;

  static styles = css`
    hc-notification-overlay {
      position: fixed;
      z-index: 2147483647;
      inset: 0;
      visibility: hidden;
      pointer-events: none;
      color: #f4f8ff;
      font-family: "Nunito", "Avenir Next", "Segoe UI", system-ui, sans-serif;
    }

    hc-notification-overlay[active],
    hc-notification-overlay[exiting] {
      visibility: visible;
    }

    hc-notification-overlay .scrim {
      position: absolute;
      inset: 0;
      opacity: 0;
      background: rgba(2, 6, 15, 0.8);
      transition: opacity 480ms ease-in-out;
    }

    hc-notification-overlay .scrim.center {
      backdrop-filter: blur(11px) saturate(0.7);
    }

    hc-notification-overlay .frame {
      position: absolute;
      z-index: 2;
      opacity: 0;
      filter: blur(7px);
      transition:
        left 800ms cubic-bezier(0.22, 1, 0.3, 1),
        top 800ms cubic-bezier(0.22, 1, 0.3, 1),
        width 800ms cubic-bezier(0.22, 1, 0.3, 1),
        transform 800ms cubic-bezier(0.22, 1, 0.3, 1),
        opacity 800ms cubic-bezier(0.22, 1, 0.3, 1),
        filter 800ms cubic-bezier(0.22, 1, 0.3, 1);
    }

    hc-notification-overlay[active] .scrim.center {
      opacity: 1;
    }

    hc-notification-overlay[active] .frame {
      opacity: 1;
      filter: blur(0);
    }

    hc-notification-overlay[exiting] .frame {
      opacity: 0;
      filter: blur(0);
      transition: opacity 480ms ease-in-out;
    }

    hc-notification-overlay[preparing] .frame,
    hc-notification-overlay[preparing] .card,
    hc-notification-overlay[preparing] .message {
      transition: none !important;
    }

    hc-notification-overlay[active] .frame.center:not(.entered) {
      opacity: 0;
      filter: blur(7px);
      transform: translate(-50%, -50%) scale(0.86);
    }

    hc-notification-overlay .frame.center {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.86);
    }

    hc-notification-overlay[active] .frame.center {
      transform: translate(-50%, -50%) scale(1);
    }

    hc-notification-overlay .frame.corner {
      top: calc(100% - 34px);
      left: calc(100% - 34px);
      transform: translate(-100%, -100%);
    }

    hc-notification-overlay .card {
      position: relative;
      isolation: isolate;
      box-sizing: border-box;
      width: 100%;
      max-height: 50vh;
      overflow: visible;
      padding: 42px 48px;
      border: 4px solid;
      border-color: rgba(var(--notification-color), 0.86);
      border-radius: 30px;
      background: linear-gradient(148deg, #090f1c 0%, #030711 92%);
      box-shadow:
        0 36px 100px rgba(0, 0, 0, 0.52),
        inset 0 0 0 1px rgba(255, 255, 255, 0.06),
        0 0 35px rgba(var(--notification-color), 0.21);
      transition:
        padding 800ms cubic-bezier(0.22, 1, 0.3, 1),
        border-radius 800ms cubic-bezier(0.22, 1, 0.3, 1),
        max-height 800ms cubic-bezier(0.22, 1, 0.3, 1),
        box-shadow 800ms cubic-bezier(0.22, 1, 0.3, 1);
    }

    hc-notification-overlay .frame.corner .card {
      max-height: 30vh;
      padding: 21px 25px;
      border-width: 2px;
      border-radius: 22px;
      box-shadow:
        0 15px 44px rgba(0, 0, 0, 0.43),
        0 0 24px rgba(var(--notification-color), 0.24);
    }

    hc-notification-overlay .sparks {
      position: absolute;
      z-index: 4;
      inset: -125px;
      width: calc(100% + 250px);
      height: calc(100% + 250px);
      pointer-events: none;
    }

    hc-notification-overlay .content {
      position: relative;
      z-index: 2;
    }

    hc-notification-overlay .title {
      margin-bottom: 16px;
      color: rgb(var(--notification-color));
      font-size: clamp(13px, 1.35vw, 18px);
      font-weight: 850;
      letter-spacing: 0.19em;
      text-align: center;
      text-transform: uppercase;
    }

    hc-notification-overlay .title[hidden] {
      display: none;
    }

    hc-notification-overlay .message {
      margin: 0;
      font-weight: 760;
      line-height: 1.13;
      letter-spacing: -0.034em;
      overflow-wrap: break-word;
      text-wrap: balance;
      text-align: center;
      transition:
        font-size 800ms cubic-bezier(0.22, 1, 0.3, 1),
        line-height 800ms cubic-bezier(0.22, 1, 0.3, 1);
    }

    hc-notification-overlay .frame.corner .title {
      margin-bottom: 8px;
      font-size: 10px;
    }

    hc-notification-overlay .frame.corner .message {
      line-height: 1.18;
    }

    hc-notification-overlay .measure {
      position: fixed;
      top: -10000px;
      left: -10000px;
      visibility: hidden;
      overflow-wrap: break-word;
      white-space: normal;
      text-wrap: balance;
      font-weight: 760;
      letter-spacing: -0.034em;
    }

    @media (max-width: 650px) {
      hc-notification-overlay .frame.center .card {
        padding: 27px 25px 29px;
      }
    }

    @media (max-height: 620px) {
      hc-notification-overlay .frame.center .card {
        padding-top: 27px;
        padding-bottom: 27px;
      }
    }

    @media (max-width: 650px) {
      hc-notification-overlay .frame.corner {
        top: calc(100% - 20px);
        left: calc(100% - 20px);
      }
    }
  `;

  protected createRenderRoot(): HTMLElement {
    if (!document.getElementById(STYLE_ELEMENT_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ELEMENT_ID;
      style.textContent = HcNotificationOverlay.styles.cssText;
      document.head.append(style);
    }
    // The receiver's ambient and loading layers are document-level surfaces.
    // Keep this transient overlay in the same paint tree so it can sit above them.
    return this;
  }

  public show(
    notification: ReceiverNotification | undefined,
    phase: NotificationPhase | undefined,
    profile: NotificationProfile | undefined
  ): void {
    this._stopAnimation();
    if (this._dismissTimer !== undefined) {
      window.clearTimeout(this._dismissTimer);
      this._dismissTimer = undefined;
    }
    this._runId += 1;
    if (!notification || !phase || !profile) {
      const runId = this._runId;
      this._edgeSparks = [];
      this._burstSparks = [];
      this.removeAttribute("preparing");
      const finish = () => {
        if (runId !== this._runId) return;
        this.removeAttribute("exiting");
        this._notification = undefined;
        this._phase = undefined;
        this._profile = undefined;
        this._entered = false;
        this._dismissTimer = undefined;
      };
      if (this.hasAttribute("active")) {
        this.setAttribute("exiting", "");
        this.removeAttribute("active");
        this._dismissTimer = window.setTimeout(finish, 480);
      } else {
        finish();
      }
      return;
    }
    if (phase === "center") {
      this.setAttribute("preparing", "");
      this.removeAttribute("active");
      this.removeAttribute("exiting");
    }
    const runId = this._runId;
    void this._prepareAndShow(notification, phase, profile, runId);
  }

  private async _prepareAndShow(
    notification: ReceiverNotification,
    phase: NotificationPhase,
    profile: NotificationProfile,
    runId: number
  ): Promise<void> {
    if (!this._measure || !this._textMeter) await this.updateComplete;
    await document.fonts?.ready;
    if (runId !== this._runId) return;

    this._notification = notification;
    this._phase = phase;
    this._profile = profile;
    this._entered = false;
    this.style.setProperty("--notification-color", COLORS[notification.level]);
    this._phaseStarted = performance.now();
    this._lastTick = this._phaseStarted;
    this._seedBurst(
      phase === "corner" ? profile.cornerEnergy : profile.centerEnergy
    );
    this._fitTypography();
    await this.updateComplete;
    if (runId !== this._runId) return;

    if (phase === "center") {
      // Apply the final layout while transitions are disabled and the overlay
      // is hidden, before starting the supplied center-entry animation.
      void this._card?.offsetWidth;
      this.removeAttribute("preparing");
    }
    this.removeAttribute("exiting");
    this.setAttribute("active", "");
    await this.updateComplete;
    if (runId !== this._runId) return;

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (runId !== this._runId) return;
        this._entered = true;
        this._resizeCanvas();
        this._startAnimation();
      })
    );
  }

  protected firstUpdated(): void {
    this._context = this._canvas?.getContext("2d");
    this._textMeter = document.createElement("canvas").getContext("2d");
    const card = this._card;
    if (card && typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => {
        this._resizeCanvas();
      });
      this._resizeObserver.observe(card);
    }
    window.addEventListener("resize", this._handleResize);
  }

  protected updated(): void {
    this._context = this._canvas?.getContext("2d");
    this._resizeCanvas();
  }

  public disconnectedCallback(): void {
    this._stopAnimation();
    if (this._dismissTimer !== undefined) {
      window.clearTimeout(this._dismissTimer);
      this._dismissTimer = undefined;
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    window.removeEventListener("resize", this._handleResize);
    super.disconnectedCallback();
  }

  protected render(): TemplateResult {
    const corner = this._phase === "corner";
    const notification = this._notification;
    const role = notification?.level === "emergency" ? "alert" : "status";
    const messageStyle = styleMap({
      fontSize: this._messageSize ? `${this._messageSize}px` : undefined,
      lineHeight: corner ? "1.18" : "1.13",
      textAlign: this._textAlign,
    });
    const titleStyle = styleMap({ textAlign: this._textAlign });
    return html`
      <div class="scrim ${corner ? "" : "center"}" aria-hidden="true"></div>
      <section
        class="frame ${corner ? "corner" : "center"} ${this._entered ? "entered" : ""}"
        style=${styleMap({ width: this._cardSize ? `${this._cardSize}px` : undefined })}
        role=${role}
        aria-live=${role === "alert" ? "assertive" : "polite"}
        aria-atomic="true"
        aria-relevant="text"
      >
        <article class="card">
          <canvas class="sparks" aria-hidden="true"></canvas>
          <div class="content">
            <div
              class="title"
              style=${titleStyle}
              ?hidden=${!notification?.title}
            >
              ${notification?.title ?? nothing}
            </div>
            <h1 class="message" style=${messageStyle}>
              ${notification?.message ?? nothing}
            </h1>
          </div>
        </article>
      </section>
      <div class="measure" aria-hidden="true"></div>
    `;
  }

  @state() private _cardSize = 0;

  @state() private _messageSize = 0;

  @state() private _textAlign: "center" | "left" = "center";

  private _handleResize = () => {
    this._fitTypography();
    this._resizeCanvas();
  };

  private _fitTypography(): void {
    const notification = this._notification;
    const phase = this._phase;
    if (!notification || !phase) return;
    const measure = this._measure;
    const textMeter = this._textMeter;
    if (!measure || !textMeter) return;
    const corner = phase === "corner";
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const compact = vw <= 650;
    const centerPaddingX = compact ? 25 : 48;
    const centerPaddingY = compact || vh <= 620 ? 27 : 42;
    const centerMaxWidth = Math.max(
      145,
      Math.min(925, vw - (compact ? 42 : 100))
    );
    const centerMinWidth = Math.min(centerMaxWidth, (26 / 100) * vw);
    const cornerMaxWidth = Math.max(
      100,
      Math.min(425, vw - (compact ? 32 : 68))
    );
    const cornerMinWidth = Math.min(cornerMaxWidth, (14 / 100) * vw);
    const centerHeight = Math.max(
      24,
      vh * 0.5 -
        2 * centerPaddingY -
        8 -
        (notification.title ? (compact ? 33 : 37) : 0)
    );
    const cornerHeight = Math.max(
      20,
      vh * 0.3 - 21 - 23 - 5 - (notification.title ? 25 : 0)
    );
    const centerTextWidth = centerMaxWidth - 2 * centerPaddingX - 8;
    const cornerTextWidth = cornerMaxWidth - 50 - 4;
    const family = getComputedStyle(this).fontFamily;
    const weight = "760";
    const message = notification.message;
    const measureWidth = (text: string, fontSize: number): number => {
      textMeter.font = `${weight} ${fontSize}px ${family}`;
      return Math.max(
        1,
        textMeter.measureText(text).width +
          (Array.from(text).length - 1) * fontSize * -0.034
      );
    };
    const multilineFontSize = (
      width: number,
      height: number,
      maxFont: number,
      lineHeight: number
    ): number => {
      measure.style.width = `${width}px`;
      measure.style.fontFamily = family;
      measure.style.fontWeight = weight;
      measure.style.lineHeight = String(lineHeight);
      measure.style.fontSize = `${maxFont}px`;
      measure.textContent = message;
      let low = 9;
      let high = maxFont;
      for (let index = 0; index < 21; index++) {
        const middle = (low + high) / 2;
        measure.style.fontSize = `${middle}px`;
        if (measure.getBoundingClientRect().height <= height) low = middle;
        else high = middle;
      }
      return low;
    };
    const singleLineFontSize = (
      maxFont: number,
      width: number,
      height: number
    ): number => {
      let low = 1;
      let high = Math.min(maxFont, height / 1.13);
      for (let index = 0; index < 21; index++) {
        const middle = (low + high) / 2;
        if (measureWidth(message, middle) <= width) low = middle;
        else high = middle;
      }
      return low;
    };

    let fontSize: number;
    let cardWidth: number;
    let textAlign: "center" | "left";
    if (corner) {
      const oneLineSize = singleLineFontSize(
        Math.max(23, Math.min(54, vw * 0.039)),
        cornerTextWidth,
        cornerHeight
      );
      if (
        oneLineSize >= Math.max(15, Math.min(23, vw * 0.02)) &&
        !message.includes("\n")
      ) {
        fontSize = oneLineSize;
        textAlign = "center";
        cardWidth = Math.max(
          cornerMinWidth,
          Math.min(
            cornerMaxWidth,
            Math.ceil(measureWidth(message, fontSize) + 50 + 10)
          )
        );
      } else {
        fontSize = multilineFontSize(
          cornerTextWidth,
          cornerHeight,
          Math.max(18, Math.min(28, vw * 0.025)),
          1.18
        );
        textAlign = "left";
        cardWidth = cornerMaxWidth;
      }
    } else {
      const oneLineSize = singleLineFontSize(
        Math.max(58, Math.min(172, vw * 0.145)),
        Math.min(centerTextWidth, 740),
        centerHeight
      );
      if (
        oneLineSize >= Math.max(23, Math.min(46, vw * 0.038)) &&
        !message.includes("\n")
      ) {
        fontSize = oneLineSize;
        textAlign = "center";
        cardWidth = Math.max(
          centerMinWidth,
          Math.min(
            centerMaxWidth,
            Math.ceil(measureWidth(message, fontSize) + centerPaddingX * 2 + 15)
          )
        );
      } else {
        fontSize = multilineFontSize(
          centerTextWidth,
          centerHeight,
          Math.max(27, Math.min(66, vw * 0.057)),
          1.13
        );
        textAlign = "left";
        cardWidth = centerMaxWidth;
      }
    }
    this._messageSize = fontSize;
    this._cardSize = cardWidth;
    this._textAlign = textAlign;
  }

  private _resizeCanvas(): void {
    const canvas = this._canvas;
    const context = this._context;
    if (!canvas || !context) return;
    const card = this._card;
    if (!card) return;
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const width = Math.round((cardWidth + 250) * dpr);
    const height = Math.round((cardHeight + 250) * dpr);
    if (!width || !height) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cardWidth = cardWidth;
    this._cardHeight = cardHeight;
  }

  private _seedBurst(energy: number): void {
    this._edgeSparks = [];
    this._burstSparks = [];
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || energy <= 0) {
      return;
    }
    const count = Math.min(
      BURST_LIMIT,
      Math.round((65 + energy * 185) * Math.sqrt(energy))
    );
    for (let index = 0; index < count; index++) {
      this._burstSparks.push({
        position: Math.random(),
        age: -Math.random() * 0.21,
        life: 0.74 + Math.random() * 0.52,
        speed: (52 + Math.random() * 78) * (0.55 + energy * 0.68),
        side: (Math.random() - 0.5) * 43,
        size: 0.65 + Math.random() * 2.1,
      });
    }
  }

  private _startAnimation(): void {
    if (
      !this._notification ||
      !this._context ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      this._paintStaticSparks();
      return;
    }
    this._frame = window.setTimeout(() => this._draw(performance.now()), 33);
  }

  private _stopAnimation(): void {
    if (this._frame !== undefined) {
      window.clearTimeout(this._frame);
      this._frame = undefined;
    }
  }

  private _draw(timestamp: number): void {
    const context = this._context;
    const canvas = this._canvas;
    const notification = this._notification;
    const phase = this._phase;
    const profile = this._profile;
    if (
      !context ||
      !canvas ||
      !notification ||
      !phase ||
      !profile ||
      document.hidden
    ) {
      this._stopAnimation();
      return;
    }
    if (timestamp - this._lastPaint < 1000 / 30) {
      this._frame = window.setTimeout(() => this._draw(performance.now()), 33);
      return;
    }
    const dt = Math.max(
      0.001,
      Math.min(0.065, (timestamp - (this._lastTick || timestamp)) / 1000)
    );
    this._lastTick = timestamp;
    this._lastPaint = timestamp;
    if (!this._resizeObserver) this._resizeCanvas();
    const width = this._cardWidth;
    const height = this._cardHeight;
    if (!width || !height) {
      this._frame = window.setTimeout(() => this._draw(performance.now()), 33);
      return;
    }
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    context.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    const remaining =
      phase === "corner"
        ? Math.max(0, 1 - (timestamp - this._phaseStarted) / profile.cornerMs)
        : 1;
    const energy =
      (phase === "corner" ? profile.cornerEnergy : profile.centerEnergy) *
      remaining;
    const spawnRate =
      (12 + energy * 170) * energy * (phase === "corner" ? remaining : 1);
    this._spawnAccumulator = Math.min(
      5,
      this._spawnAccumulator + spawnRate * dt
    );
    while (
      this._spawnAccumulator >= 1 &&
      this._edgeSparks.length < EDGE_LIMIT
    ) {
      this._spawnAccumulator -= 1;
      this._edgeSparks.push({
        position: Math.random(),
        age: 0,
        life: 0.34 + Math.random() * 0.78,
        speed: (11 + Math.random() * 35) * (0.5 + energy * 0.85),
        side: (Math.random() - 0.5) * 26,
        size: 0.55 + Math.random() * 1.65,
      });
    }
    this._edgeSparks = this._edgeSparks.filter(
      (spark) => spark.age < spark.life
    );
    this._burstSparks = this._burstSparks.filter(
      (spark) => spark.age < spark.life
    );
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const spark of this._edgeSparks) {
      this._drawSpark(context, spark, width, height, false, energy, dt);
    }
    for (const spark of this._burstSparks) {
      this._drawSpark(context, spark, width, height, true, energy, dt);
    }
    context.restore();
    this._frame = window.setTimeout(() => this._draw(performance.now()), 33);
  }

  private _drawSpark(
    context: CanvasRenderingContext2D,
    spark: Spark,
    width: number,
    height: number,
    burst: boolean,
    energy: number,
    dt: number
  ): void {
    spark.age += dt;
    if (spark.age < 0 || spark.age >= spark.life) return;
    const progress = spark.age / spark.life;
    const padding = 125;
    const edge = this._edgePoint(
      spark.position,
      width,
      height,
      this._phase === "corner" ? 22 : 30
    );
    const travel = spark.age * spark.speed;
    const slide = spark.age * spark.side;
    const x = padding + edge[0] + edge[2] * travel + edge[4] * slide;
    const y = padding + edge[1] + edge[3] * travel + edge[5] * slide;
    const alpha =
      (burst ? (1 - progress) ** 1.05 : Math.sin(Math.PI * progress)) *
      energy *
      (burst ? 0.97 : 0.85) *
      (0.75 + spark.size * 0.17);
    if (alpha <= 0) return;
    const sprite = this._getSparkSprite(this._notification!.level);
    if (!sprite) return;
    const radius = spark.size * (burst ? 4.1 : 3.3);
    context.globalAlpha = alpha;
    context.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
    context.globalAlpha = 1;
  }

  private _paintStaticSparks(): void {
    if (!this._context || !this._canvas || !this._notification) return;
    this._resizeCanvas();
    const width = this._cardWidth;
    const height = this._cardHeight;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this._context.clearRect(
      0,
      0,
      this._canvas.width / dpr,
      this._canvas.height / dpr
    );
    const sprite = this._getSparkSprite(this._notification.level);
    if (!sprite) return;
    for (let index = 0; index < 24; index++) {
      const position = index / 24;
      const edge = this._edgePoint(
        position,
        width,
        height,
        this._phase === "corner" ? 22 : 30
      );
      const x = 125 + edge[0];
      const y = 125 + edge[1];
      this._context.globalAlpha = 0.7;
      this._context.drawImage(sprite, x - 10, y - 10, 20, 20);
    }
    this._context.globalAlpha = 1;
  }

  private _getSparkSprite(
    level: keyof typeof COLORS
  ): HTMLCanvasElement | undefined {
    if (this._sparkSprites.has(level)) {
      return this._sparkSprites.get(level) ?? undefined;
    }
    const sprite = document.createElement("canvas");
    sprite.width = 64;
    sprite.height = 64;
    const context = sprite.getContext("2d");
    if (!context) {
      this._sparkSprites.set(level, null);
      return undefined;
    }
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    const color = COLORS[level];
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.22, `rgba(${color},0.8)`);
    gradient.addColorStop(1, `rgba(${color},0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    this._sparkSprites.set(level, sprite);
    return sprite;
  }

  private _edgePoint(
    position: number,
    width: number,
    height: number,
    radius: number
  ): [number, number, number, number, number, number] {
    const wrap = (value: number) => ((value % 1) + 1) % 1;
    const length = Math.max(0, width - 2 * radius);
    const vertical = Math.max(0, height - 2 * radius);
    const quarter = (Math.PI * radius) / 2;
    let distance = wrap(position) * (2 * length + 2 * vertical + 4 * quarter);
    let angle: number;
    if (distance < length) return [radius + distance, 0, 0, -1, 1, 0];
    distance -= length;
    if (distance < quarter) {
      angle = -Math.PI / 2 + distance / radius;
      return [
        width - radius + radius * Math.cos(angle),
        radius + radius * Math.sin(angle),
        Math.cos(angle),
        Math.sin(angle),
        -Math.sin(angle),
        Math.cos(angle),
      ];
    }
    distance -= quarter;
    if (distance < vertical) return [width, radius + distance, 1, 0, 0, 1];
    distance -= vertical;
    if (distance < quarter) {
      angle = distance / radius;
      return [
        width - radius + radius * Math.cos(angle),
        height - radius + radius * Math.sin(angle),
        Math.cos(angle),
        Math.sin(angle),
        -Math.sin(angle),
        Math.cos(angle),
      ];
    }
    distance -= quarter;
    if (distance < length) {
      return [width - radius - distance, height, 0, 1, -1, 0];
    }
    distance -= length;
    if (distance < quarter) {
      angle = Math.PI / 2 + distance / radius;
      return [
        radius + radius * Math.cos(angle),
        height - radius + radius * Math.sin(angle),
        Math.cos(angle),
        Math.sin(angle),
        -Math.sin(angle),
        Math.cos(angle),
      ];
    }
    distance -= quarter;
    if (distance < vertical) {
      return [0, height - radius - distance, -1, 0, 0, -1];
    }
    distance -= vertical;
    angle = Math.PI + distance / radius;
    return [
      radius + radius * Math.cos(angle),
      radius + radius * Math.sin(angle),
      Math.cos(angle),
      Math.sin(angle),
      -Math.sin(angle),
      Math.cos(angle),
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hc-notification-overlay": HcNotificationOverlay;
  }
}
