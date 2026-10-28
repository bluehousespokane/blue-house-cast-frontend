import { assert, describe, it } from "vitest";
import {
  NOTIFICATION_PROFILES,
  ReceiverNotificationQueue,
} from "../../cast/src/receiver/notifications";
import type { NotificationLevel } from "../../src/cast/receiver_messages";

class TestClock {
  private _nextId = 0;
  private _timers = new Map<number, { at: number; callback: () => void }>();
  public now = 1000;

  public setTimer = (callback: () => void, milliseconds: number): number => {
    const id = ++this._nextId;
    this._timers.set(id, { at: this.now + milliseconds, callback });
    return id;
  };

  public clearTimer = (id: number): void => {
    this._timers.delete(id);
  };

  public advance(milliseconds: number): void {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this._timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((first, second) => first[1].at - second[1].at)[0];
      if (!next) break;
      this._timers.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = end;
  }
}

function notification(requestId: string, level: NotificationLevel = "routine") {
  return {
    requestId,
    senderId: "home-assistant",
    title: "",
    message: `Message ${requestId}`,
    level,
  };
}

function createQueue() {
  const clock = new TestClock();
  const presentations: { requestId?: string; phase?: string }[] = [];
  const statuses: {
    requestId: string;
    outcome: string;
    startedAt: number;
    queuedCount: number;
    reason?: string;
    error?: string;
  }[] = [];
  const queue = new ReceiverNotificationQueue(
    (item, phase) => presentations.push({ requestId: item?.requestId, phase }),
    (item, status) => statuses.push({ ...status, requestId: item.requestId }),
    () => clock.now,
    clock.setTimer,
    clock.clearTimer
  );
  return { clock, presentations, queue, statuses };
}

describe("Cast receiver notification queue", () => {
  it("uses bounded duration and energy profiles by level", () => {
    assert.deepEqual(NOTIFICATION_PROFILES, {
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
    });
  });

  it("replaces center items in FIFO order and keeps original acceptance times", () => {
    const { clock, presentations, queue, statuses } = createQueue();
    queue.enqueue(notification("first"));
    clock.advance(100);
    queue.enqueue(notification("second"));
    clock.advance(100);
    queue.enqueue(notification("third"));

    clock.advance(2800);
    assert.deepEqual(presentations[presentations.length - 1], {
      requestId: "second",
      phase: "center",
    });
    clock.advance(3000);
    assert.deepEqual(presentations[presentations.length - 1], {
      requestId: "third",
      phase: "center",
    });
    assert.equal(
      statuses.find((status) => status.requestId === "second")?.startedAt,
      1100
    );
    assert.equal(
      statuses.find((status) => status.requestId === "third")?.startedAt,
      1200
    );
    assert.isFalse("message" in statuses[0]);
  });

  it("starts a new notification immediately during the corner phase", () => {
    const { clock, presentations, queue, statuses } = createQueue();
    queue.enqueue(notification("current"));
    clock.advance(3800);
    assert.deepEqual(presentations[presentations.length - 1], {
      requestId: "current",
      phase: "corner",
    });

    queue.enqueue(notification("replacement", "important"));
    assert.deepEqual(presentations[presentations.length - 1], {
      requestId: "replacement",
      phase: "center",
    });
    assert.equal(
      statuses.find(
        (status) =>
          status.requestId === "current" && status.outcome === "completed"
      )?.reason,
      "replaced"
    );
  });

  it("accepts one active plus five queued and rejects overflow", () => {
    const { queue } = createQueue();
    for (let index = 0; index < 6; index++) {
      assert.isUndefined(queue.enqueue(notification(String(index))));
    }
    assert.equal(queue.size, 6);
    assert.equal(queue.queuedCount, 5);
    assert.equal(
      queue.enqueue(notification("overflow")),
      "The notification queue is full."
    );
  });

  it("rejects prototype property names as notification levels", () => {
    const { queue } = createQueue();
    assert.equal(
      queue.enqueue(notification("invalid", "toString" as NotificationLevel)),
      "Unsupported notification level."
    );
  });

  it("interrupts queued and active notifications when the receiver is hidden", () => {
    const { queue, statuses } = createQueue();
    queue.enqueue(notification("active"));
    queue.enqueue(notification("waiting"));
    queue.setVisible(false);

    assert.equal(queue.size, 0);
    assert.deepEqual(
      statuses
        .filter((status) => status.outcome === "interrupted")
        .map((status) => status.requestId),
      ["active", "waiting"]
    );
    assert.isTrue(
      statuses
        .filter((status) => status.outcome === "interrupted")
        .every((status) => status.queuedCount === 0)
    );
    assert.equal(
      queue.enqueue(notification("hidden")),
      "The receiver is not in the foreground."
    );
  });
});
