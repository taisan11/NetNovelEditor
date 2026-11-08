// Deterministic browser/timer stand-ins: no real waits in scheduling tests.
export function createSyncClock() {
  const keys = ["window", "document", "navigator", "setTimeout", "clearTimeout"] as const;
  const descriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const originalNow = Date.now;
  let now = 1_000_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    documentElement: { style: { setProperty() {} }, dataset: {} },
  });
  const navigator = { onLine: true };
  Date.now = () => now;
  for (const [key, value] of Object.entries({
    window, document, navigator,
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const nextTimer = () => [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  return {
    window, document, navigator, settle,
    pendingTimers: () => timers.size,
    nextDelay: () => {
      const next = nextTimer();
      return next ? next[1].at - now : null;
    },
    async advance(ms: number) {
      const target = now + ms;
      await settle();
      for (let count = 0; ; count++) {
        const next = nextTimer();
        if (!next || next[1].at > target) break;
        if (count > 1_000) throw new Error("Timer loop did not settle");
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
    restore() {
      Date.now = originalNow;
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
