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
    :host {
      position: fixed;
      z-index: 2147483646;
      inset: 0;
      visibility: hidden;
      pointer-events: none;
      color: #f4f8ff;
      font-family: "Nunito", "Avenir Next", "Segoe UI", system-ui, sans-serif;
      font-synthesis: none;
    }

    :host([active]) {
      visibility: visible;
    }

    .scrim {
      position: absolute;
      inset: 0;
      opacity: 0;
      background: rgba(2, 6, 15, 0.8);
      backdrop-filter: blur(11px) saturate(0.7);
      transition: opacity 480ms ease-in-out;
    }

    .frame {
      position: absolute;
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

    :host([active]) .scrim {
      opacity: 1;
    }

    :host([active]) .frame {
      opacity: 1;
      filter: blur(0);
    }

    :host([active]) .frame.center:not(.entered) {
      opacity: 0;
      filter: blur(7px);
      transform: translate(-50%, -50%) scale(0.86);
    }

    .frame.center {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.86);
    }

    :host([active]) .frame.center {
      transform: translate(-50%, -50%) scale(1);
    }

    .frame.corner {
      bottom: 34px;
      left: 34px;
      transform: none;
    }

    .card {
      position: relative;
      isolation: isolate;
      box-sizing: border-box;
      width: 100%;
      max-height: 50vh;
      overflow: visible;
      padding: 42px 48px;
      border: 4px solid rgba(var(--notification-color), 0.86);
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

    .frame.corner .card {
      max-height: 30vh;
      padding: 21px 25px 23px;
      border-width: 2px;
      border-radius: 22px;
      box-shadow:
        0 15px 44px rgba(0, 0, 0, 0.43),
        0 0 24px rgba(var(--notification-color), 0.24);
    }

    .sparks {
      position: absolute;
      z-index: 1;
      inset: -125px;
      width: calc(100% + 250px);
      height: calc(100% + 250px);
      pointer-events: none;
    }

    .content {
      position: relative;
      z-index: 2;
    }

    .title {
      margin-bottom: 16px;
      color: rgb(var(--notification-color));
      font-size: clamp(13px, 1.35vw, 18px);
      font-weight: 850;
      letter-spacing: 0.19em;
      text-align: center;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .title[hidden] {
      display: none;
    }

    .message {
      margin: 0;
      font-weight: 760;
      line-height: 1.13;
      letter-spacing: -0.034em;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      text-align: center;
    }

    .frame.corner .title {
      margin-bottom: 8px;
      font-size: 12px;
      text-align: left;
    }

    .frame.corner .message {
      line-height: 1.18;
      text-align: left;
    }

    .measure {
      position: fixed;
      top: -10000px;
      left: -10000px;
      visibility: hidden;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      font-weight: 760;
      letter-spacing: -0.034em;
    }

    @media (max-width: 650px) {
      .frame.center .card {
        padding: 27px 25px 29px;
      }
    }

    @media (max-height: 620px) {
      .frame.center .card {
        padding-top: 27px;
        padding-bottom: 27px;
      }
    }

    @media (max-width: 650px) {
      .frame.corner {
        bottom: 20px;
        left: 20px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .scrim,
      .frame,
      .card {
        transition-duration: 0ms;
      }
    }
  `;

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
    this._notification = notification;
    this._phase = phase;
    this._profile = profile;
    this._entered = false;
    if (!notification || !phase || !profile) {
      const runId = this._runId;
      this._edgeSparks = [];
      this._burstSparks = [];
      this._dismissTimer = window.setTimeout(() => {
        if (runId === this._runId) this.removeAttribute("active");
        this._dismissTimer = undefined;
      }, 480);
      return;
    }
    this.setAttribute("active", "");
    this.style.setProperty("--notification-color", COLORS[notification.level]);
    this._phaseStarted = performance.now();
    this._lastTick = this._phaseStarted;
    this._seedBurst(
      phase === "corner" ? profile.cornerEnergy : profile.centerEnergy
    );
    const runId = this._runId;
    void this.updateComplete.then(() => {
      if (runId !== this._runId) return;
      this._fitTypography();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (runId !== this._runId) return;
          this._entered = true;
          this._resizeCanvas();
          this._startAnimation();
        })
      );
    });
  }

  protected firstUpdated(): void {
    this._context = this._canvas?.getContext("2d");
    const card = this._card;
    if (card && typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => {
        this._fitTypography();
        this._resizeCanvas();
      });
      this._resizeObserver.observe(card);
    }
    window.addEventListener("resize", this._handleResize);
    document.fonts?.ready.then(() => this._fitTypography());
  }

  protected updated(): void {
    this._context = this._canvas?.getContext("2d");
    if (this._notification) {
      this._fitTypography();
      this._resizeCanvas();
    }
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
      textAlign: corner ? "left" : "center",
    });
    const titleStyle = styleMap({ textAlign: corner ? "left" : "center" });
    return html`
      <div class="scrim" aria-hidden="true"></div>
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
              ${this._displayMessage ?? notification?.message ?? nothing}
            </h1>
          </div>
        </article>
      </section>
      <div class="measure" aria-hidden="true"></div>
    `;
  }

  @state() private _cardSize = 0;

  @state() private _messageSize = 0;

  @state() private _displayMessage?: string;

  private _handleResize = () => {
    this._fitTypography();
    this._resizeCanvas();
  };

  private _fitTypography(): void {
    const notification = this._notification;
    const phase = this._phase;
    if (!notification || !phase) return;
    const measure = this._measure;
    if (!measure) return;
    const corner = phase === "corner";
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxWidth = Math.max(
      120,
      Math.min(corner ? 425 : 925, vw - (corner ? 68 : 100))
    );
    const minWidth = Math.min(maxWidth, vw * (corner ? 0.14 : 0.26));
    const paddingX = corner ? 50 : vw <= 650 ? 50 : 96;
    const paddingY = corner ? 49 : vw <= 650 || vh <= 620 ? 56 : 84;
    const titleHeight = notification.title ? (corner ? 32 : 43) : 0;
    const maxHeight = Math.max(
      34,
      vh * (corner ? 0.3 : 0.5) - paddingY - titleHeight - 8
    );
    const textWidth = Math.max(70, maxWidth - paddingX - 8);
    const lineHeight = corner ? 1.18 : 1.13;
    const maxFont = corner
      ? Math.min(54, Math.max(23, vw * 0.039))
      : Math.min(172, Math.max(58, vw * 0.145));
    const minFont = corner ? 18 : 24;
    const family = getComputedStyle(this).fontFamily;
    measure.style.width = `${textWidth}px`;
    measure.style.fontFamily = family;
    measure.style.lineHeight = String(lineHeight);
    const original = Array.from(notification.message);

    const heightAt = (text: string, fontSize: number): number => {
      measure.style.fontSize = `${fontSize}px`;
      measure.textContent = text;
      return measure.getBoundingClientRect().height;
    };

    let display = notification.message;
    let low = minFont;
    let high = maxFont;
    if (heightAt(display, low) > maxHeight) {
      let left = 0;
      let right = original.length;
      while (left < right) {
        const middle = Math.ceil((left + right) / 2);
        if (
          heightAt(`${original.slice(0, middle).join("")}…`, minFont) <=
          maxHeight
        ) {
          left = middle;
        } else {
          right = middle - 1;
        }
      }
      display = `${original.slice(0, left).join("")}…`;
      high = minFont;
    }
    for (let index = 0; index < 16; index++) {
      const middle = (low + high) / 2;
      if (heightAt(display, middle) <= maxHeight) low = middle;
      else high = middle;
    }
    const fontSize = Math.max(minFont, low);
    measure.style.fontSize = `${fontSize}px`;
    measure.style.width = "max-content";
    measure.style.whiteSpace = "pre";
    measure.textContent = display;
    const singleLineWidth = measure.getBoundingClientRect().width;
    const oneLine = !display.includes("\n") && singleLineWidth <= textWidth;
    this._displayMessage =
      display === notification.message ? undefined : display;
    this._messageSize = fontSize;
    this._cardSize = oneLine
      ? Math.max(
          minWidth,
          Math.min(maxWidth, Math.ceil(singleLineWidth + paddingX + 15))
        )
      : maxWidth;
  }

  private _resizeCanvas(): void {
    const canvas = this._canvas;
    const context = this._context;
    if (!canvas || !context) return;
    const card = this._card;
    if (!card) return;
    const bounds = card.getBoundingClientRect();
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const width = Math.round((bounds.width + 250) * dpr);
    const height = Math.round((bounds.height + 250) * dpr);
    if (!width || !height) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cardWidth = bounds.width;
    this._cardHeight = bounds.height;
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
    this._resizeCanvas();
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
