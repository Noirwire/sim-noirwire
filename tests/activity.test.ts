import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity, type Lifecycle } from "../src/activity/activity.js";

const IDLE_MS = 10 * 60_000;
const AFTER_LAST_SOCKET_MS = 15_000;

/** A lifecycle that counts its calls and finishes a wake only when the test lets it. */
const recordingLifecycle = () => {
  const calls: string[] = [];
  const state = {
    wakeError: null as Error | null,
    wakeHeld: null as (() => void) | null,
    holdWake: false,
  };
  const lifecycle: Lifecycle = {
    wake: async () => {
      calls.push("wake");
      if (state.wakeError) throw state.wakeError;
      if (state.holdWake) await new Promise<void>((resolve) => (state.wakeHeld = resolve));
    },
    sleep: async () => {
      calls.push("sleep");
    },
  };
  return { calls, state, lifecycle };
};

const activityOn = (lifecycle: Lifecycle, errors: string[] = []) =>
  new Activity({
    lifecycle,
    idleAfterMs: IDLE_MS,
    idleAfterLastSocketMs: AFTER_LAST_SOCKET_MS,
    onError: (what) => errors.push(what),
  });

describe("when the service is awake", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts asleep and sends nothing until something asks for activity", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);

    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);

    expect(activity.phase).toBe("asleep");
    expect(activity.awake).toBe(false);
    expect(calls).toEqual([]);
  });

  it("wakes on a request without making the request wait for the wake", async () => {
    const { calls, state, lifecycle } = recordingLifecycle();
    state.holdWake = true;
    const activity = activityOn(lifecycle);

    activity.touch();
    expect(activity.phase).toBe("waking");
    expect(activity.waking).toBe(true);
    expect(activity.awake).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["wake"]);
    expect(activity.phase).toBe("waking");

    state.wakeHeld?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(activity.phase).toBe("awake");
    expect(activity.waking).toBe(false);
  });

  it("wakes once for any number of requests that arrive while it wakes", async () => {
    const { calls, state, lifecycle } = recordingLifecycle();
    state.holdWake = true;
    const activity = activityOn(lifecycle);

    activity.touch();
    activity.touch();
    activity.touch();
    await vi.advanceTimersByTimeAsync(0);
    state.wakeHeld?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["wake"]);
  });

  it("rests when the rollup stops answering, probes with the wake's growing wait, and resumes once it answers", async () => {
    const { calls, state, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    activity.socketOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["wake"]);

    state.wakeError = new Error("403 Forbidden");
    activity.unreachable();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["wake", "sleep", "wake"]);
    expect(activity.phase).toBe("waking");
    expect(activity.wakeFailure).toBe("403 Forbidden");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(6);

    state.wakeError = null;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toHaveLength(7);
    expect(activity.phase).toBe("awake");
    expect(activity.wakeFailure).toBeNull();
  });

  it("ignores a rollup that stopped answering while nothing is awake", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);

    activity.unreachable();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toEqual([]);
  });

  it("sleeps once the idle time has passed since the last request", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    activity.touch();
    await vi.advanceTimersByTimeAsync(0);
    expect(activity.phase).toBe("awake");

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(activity.phase).toBe("awake");

    await vi.advanceTimersByTimeAsync(1);
    expect(activity.phase).toBe("asleep");
    expect(calls).toEqual(["wake", "sleep"]);
  });

  it("counts the idle time from the last request, not the first", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    activity.touch();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);

    activity.touch();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(activity.phase).toBe("awake");

    await vi.advanceTimersByTimeAsync(1);
    expect(activity.phase).toBe("asleep");
    expect(calls).toEqual(["wake", "sleep"]);
  });

  it("stays awake for as long as a stream socket is open, however long that is", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    const closeSocket = activity.socketOpened();

    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);

    expect(activity.phase).toBe("awake");
    expect(calls).toEqual(["wake"]);

    closeSocket();
    await vi.advanceTimersByTimeAsync(AFTER_LAST_SOCKET_MS - 1);
    expect(activity.phase).toBe("awake");
    await vi.advanceTimersByTimeAsync(1);
    expect(activity.phase).toBe("asleep");
    expect(calls).toEqual(["wake", "sleep"]);
  });

  it("sleeps soon after the page closes, even though the page made requests", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    activity.touch();
    const closeSocket = activity.socketOpened();
    activity.touch();
    await vi.advanceTimersByTimeAsync(60_000);

    closeSocket();
    await vi.advanceTimersByTimeAsync(AFTER_LAST_SOCKET_MS);

    expect(activity.phase).toBe("asleep");
    expect(calls).toEqual(["wake", "sleep"]);
  });

  it("keeps trading through a page reload that reconnects within the grace", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    const before = activity.socketOpened();
    await vi.advanceTimersByTimeAsync(0);

    before();
    await vi.advanceTimersByTimeAsync(AFTER_LAST_SOCKET_MS - 1_000);
    activity.socketOpened();
    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(activity.phase).toBe("awake");
    expect(calls).toEqual(["wake"]);
  });

  it("gives a request after the page closed the full idle time", async () => {
    const { lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    const closeSocket = activity.socketOpened();
    await vi.advanceTimersByTimeAsync(0);
    closeSocket();

    activity.touch();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(activity.phase).toBe("awake");
    await vi.advanceTimersByTimeAsync(1);
    expect(activity.phase).toBe("asleep");
  });

  it("stays awake while any one of several sockets is open", async () => {
    const { lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    const first = activity.socketOpened();
    const second = activity.socketOpened();

    first();
    first();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(activity.phase).toBe("awake");

    second();
    await vi.advanceTimersByTimeAsync(AFTER_LAST_SOCKET_MS);
    expect(activity.phase).toBe("asleep");
  });

  it("wakes again for a request that arrives after it went to sleep", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    activity.touch();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(activity.phase).toBe("asleep");

    activity.touch();
    await vi.advanceTimersByTimeAsync(0);

    expect(activity.phase).toBe("awake");
    expect(calls).toEqual(["wake", "sleep", "wake"]);
  });

  it("keeps a service it was told to hold awake awake for good", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    activity.holdAwake();

    await vi.advanceTimersByTimeAsync(IDLE_MS * 10);

    expect(activity.phase).toBe("awake");
    expect(calls).toEqual(["wake"]);
  });

  it("puts a service to sleep when its start-up work is done and nobody has asked for it", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);

    activity.settle();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["sleep"]);
    expect(activity.phase).toBe("asleep");
  });

  it("leaves a service awake that a request woke during its start-up work", async () => {
    const { calls, lifecycle } = recordingLifecycle();
    const activity = activityOn(lifecycle);
    activity.touch();

    activity.settle();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["wake"]);
    expect(activity.phase).toBe("awake");
  });

  it("wakes after the sleep that was running when a request came in", async () => {
    const calls: string[] = [];
    let finishSleep = (): void => {};
    const activity = activityOn({
      wake: async () => {
        calls.push("wake");
      },
      sleep: () => {
        calls.push("sleep");
        return new Promise<void>((resolve) => (finishSleep = resolve));
      },
    });
    activity.settle();
    await vi.advanceTimersByTimeAsync(0);

    activity.touch();
    expect(activity.phase).toBe("waking");
    finishSleep();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["sleep", "wake"]);
    expect(activity.phase).toBe("awake");
  });
});

describe("when the rollup refuses a wake", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tries again with a growing wait, says why, and is awake once it works", async () => {
    const { calls, state, lifecycle } = recordingLifecycle();
    const errors: string[] = [];
    state.wakeError = new Error("403 Forbidden\n<html>");
    const activity = activityOn(lifecycle, errors);
    activity.touch();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["wake"]);
    expect(activity.phase).toBe("waking");
    expect(activity.wakeFailure).toBe("403 Forbidden");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);

    state.wakeError = null;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(activity.phase).toBe("awake");
    expect(activity.wakeFailure).toBeNull();
    expect(errors.every((what) => what === "waking the service")).toBe(true);
  });

  it("gives up and goes back to sleep when nobody wants it any more", async () => {
    const { calls, state, lifecycle } = recordingLifecycle();
    state.wakeError = new Error("403 Forbidden");
    const activity = activityOn(lifecycle);
    activity.touch();

    await vi.advanceTimersByTimeAsync(IDLE_MS + 5 * 60_000);

    expect(activity.phase).toBe("asleep");
    expect(calls[calls.length - 1]).toBe("sleep");
    const wakes = calls.filter((call) => call === "wake").length;
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(calls.filter((call) => call === "wake")).toHaveLength(wakes);
  });
});
