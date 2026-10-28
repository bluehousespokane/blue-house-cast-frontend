import type { NotificationLevel } from "../../../src/cast/receiver_messages";

export interface ReceiverNotification {
  requestId: string;
  senderId: string;
  title: string;
  message: string;
  level: NotificationLevel;
}

export type NotificationPhase = "center" | "corner";
export type NotificationOutcome =
  "queued" | "displayed" | "corner" | "completed" | "interrupted" | "failed";

export interface NotificationStatus {
  requestId: string;
  outcome: NotificationOutcome;
  queuedCount: number;
  error?: string;
  reason?: string;
  startedAt: number;
  updatedAt: number;
}

export interface NotificationProfile {
  centerMs: number;
  cornerMs: number;
  centerEnergy: number;
  cornerEnergy: number;
}

export const NOTIFICATION_PROFILES: Record<
  NotificationLevel,
  NotificationProfile
> = {
  routine: {
    centerMs: 3000,
    cornerMs: 9000,
    centerEnergy: 0.35,
    cornerEnergy: 0.12,
  },
  notice: {
    centerMs: 3000,
    cornerMs: 9000,
    centerEnergy: 0.55,
    cornerEnergy: 0.2,
  },
  important: {
    centerMs: 5000,
    cornerMs: 15000,
    centerEnergy: 0.8,
    cornerEnergy: 0.35,
  },
  emergency: {
    centerMs: 10000,
    cornerMs: 30000,
    centerEnergy: 1,
    cornerEnergy: 0.5,
  },
};

const MAX_QUEUED_NOTIFICATIONS = 5;
const TRANSITION_MS = 800;

type PresentNotification = (
  notification: ReceiverNotification | undefined,
  phase: NotificationPhase | undefined,
  profile: NotificationProfile | undefined
) => void;
type PublishStatus = (
  notification: ReceiverNotification,
  status: NotificationStatus
) => void;

interface QueueEntry {
  notification: ReceiverNotification;
  profile: NotificationProfile;
  startedAt: number;
}

/** Volatile, receiver-session notification queue. */
export class ReceiverNotificationQueue {
  private _current?: QueueEntry;
  private _waiting: QueueEntry[] = [];
  private _phase?: NotificationPhase;
  private _timer?: number;
  private _visible = true;

  constructor(
    private readonly _present: PresentNotification,
    private readonly _publish: PublishStatus,
    private readonly _now: () => number = Date.now,
    private readonly _setTimer: (
      callback: () => void,
      milliseconds: number
    ) => number = (callback, milliseconds) =>
      window.setTimeout(callback, milliseconds),
    private readonly _clearTimer: (timer: number) => void = (timer) =>
      window.clearTimeout(timer)
  ) {}

  public get queuedCount(): number {
    return this._waiting.length;
  }

  public get size(): number {
    return this._waiting.length + (this._current ? 1 : 0);
  }

  public hasRequest(requestId: string): boolean {
    return (
      this._current?.notification.requestId === requestId ||
      this._waiting.some((entry) => entry.notification.requestId === requestId)
    );
  }

  public enqueue(notification: ReceiverNotification): string | undefined {
    if (!this._visible) return "The receiver is not in the foreground.";
    if (
      !Object.prototype.hasOwnProperty.call(
        NOTIFICATION_PROFILES,
        notification.level
      )
    ) {
      return "Unsupported notification level.";
    }
    if (this.hasRequest(notification.requestId)) return undefined;
    if (!this._current) {
      this._start(this._makeEntry(notification));
      return undefined;
    }
    if (this._phase === "corner") {
      this._completeCurrent("replaced");
      this._start(this._makeEntry(notification));
      return undefined;
    }
    if (this._waiting.length >= MAX_QUEUED_NOTIFICATIONS) {
      return "The notification queue is full.";
    }
    const entry = this._makeEntry(notification);
    this._waiting.push(entry);
    this._emit(entry, "queued");
    return undefined;
  }

  public setVisible(visible: boolean): void {
    this._visible = visible;
    if (!visible) this.clear("interrupted");
  }

  public clear(outcome: "interrupted" | "failed" = "interrupted"): void {
    this._clearCurrentTimer();
    const current = this._current;
    const waiting = this._waiting;
    this._current = undefined;
    this._waiting = [];
    this._phase = undefined;
    if (current) this._emit(current, outcome);
    for (const entry of waiting) this._emit(entry, outcome);
    this._present(undefined, undefined, undefined);
  }

  private _makeEntry(notification: ReceiverNotification): QueueEntry {
    return {
      notification,
      profile: NOTIFICATION_PROFILES[notification.level],
      startedAt: this._now(),
    };
  }

  private _start(entry: QueueEntry): void {
    const notification = entry.notification;
    this._current = entry;
    this._phase = "center";
    this._present(notification, "center", entry.profile);
    this._clearCurrentTimer();
    this._timer = this._setTimer(() => {
      if (this._current !== entry || !this._visible) return;
      this._emit(entry, "displayed");
      this._timer = this._setTimer(
        () => this._centerElapsed(entry),
        entry.profile.centerMs - TRANSITION_MS
      );
    }, TRANSITION_MS);
  }

  private _centerElapsed(entry: QueueEntry): void {
    if (this._current !== entry || !this._visible) return;
    if (this._waiting.length) {
      this._completeCurrent("replaced");
      const next = this._waiting.shift()!;
      this._start(next);
      return;
    }
    this._phase = "corner";
    this._present(entry.notification, "corner", entry.profile);
    this._clearCurrentTimer();
    this._timer = this._setTimer(() => {
      if (this._current !== entry || !this._visible) return;
      this._emit(entry, "corner");
      this._timer = this._setTimer(
        () => this._completeCurrent("expired"),
        entry.profile.cornerMs - TRANSITION_MS
      );
    }, TRANSITION_MS);
  }

  private _completeCurrent(reason: string): void {
    if (!this._current) return;
    const entry = this._current;
    this._clearCurrentTimer();
    this._emit(entry, "completed", reason);
    this._current = undefined;
    this._phase = undefined;
    this._present(undefined, undefined, undefined);
  }

  private _emit(
    entry: QueueEntry,
    outcome: NotificationOutcome,
    reason?: string
  ): void {
    const updatedAt = this._now();
    this._publish(entry.notification, {
      requestId: entry.notification.requestId,
      outcome,
      queuedCount: this._waiting.length,
      reason,
      startedAt: entry.startedAt,
      updatedAt,
    });
  }

  private _clearCurrentTimer(): void {
    if (this._timer !== undefined) {
      this._clearTimer(this._timer);
      this._timer = undefined;
    }
  }
}
