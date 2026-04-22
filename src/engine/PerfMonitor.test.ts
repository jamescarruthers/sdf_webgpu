import { describe, expect, it } from "vitest";
import { PerfMonitor } from "./PerfMonitor";

function feed(p: PerfMonitor, frameMs: number, count: number): void {
  for (let i = 0; i < count; i++) p.observe(frameMs, 16.6);
}

describe("PerfMonitor.initialScaleForViewport", () => {
  it("returns 1 when the viewport fits inside the target pixel budget", () => {
    expect(PerfMonitor.initialScaleForViewport(1280, 720, 1)).toBe(1);
    expect(PerfMonitor.initialScaleForViewport(1920, 1080, 1)).toBe(1);
  });

  it("scales down sub-linearly with pixel count for large viewports", () => {
    const s = PerfMonitor.initialScaleForViewport(3840, 2160, 2);
    expect(s).toBeLessThan(0.5);
    expect(s).toBeGreaterThanOrEqual(0.25);
  });

  it("never drops below the 0.25 floor", () => {
    const s = PerfMonitor.initialScaleForViewport(8000, 6000, 2);
    expect(s).toBeGreaterThanOrEqual(0.25);
  });
});

describe("PerfMonitor adaptive scaling", () => {
  it("ignores warm-up frames", () => {
    const p = new PerfMonitor(1.0, { warmupFrames: 10, badStreakToShrink: 2, highWaterMs: 30 });
    feed(p, 200, 10); // all during warmup
    expect(p.renderScale).toBe(1.0);
  });

  it("shrinks the render scale after a sustained bad streak", () => {
    const p = new PerfMonitor(1.0, { warmupFrames: 0, badStreakToShrink: 4, highWaterMs: 30, minScale: 0.25 });
    let changed = false;
    for (let i = 0; i < 8; i++) {
      const obs = p.observe(60, 16.6);
      if (obs.scaleChanged) changed = true;
    }
    expect(changed).toBe(true);
    expect(p.renderScale).toBeLessThan(1.0);
    expect(p.renderScale).toBeGreaterThanOrEqual(0.25);
  });

  it("grows the render scale after a sustained good streak", () => {
    const p = new PerfMonitor(0.5, {
      warmupFrames: 0,
      badStreakToShrink: 4,
      goodStreakToGrow: 10,
      lowWaterMs: 12,
      maxScale: 1.0,
    });
    const start = p.renderScale;
    for (let i = 0; i < 20; i++) p.observe(8, 16.6);
    expect(p.renderScale).toBeGreaterThan(start);
  });

  it("pauses when a single frame blows past panicMs at the floor scale", () => {
    const p = new PerfMonitor(0.25, { warmupFrames: 0, panicMs: 500, minScale: 0.25 });
    const obs = p.observe(800, 16.6);
    expect(obs.paused).toBe(true);
    expect(p.paused).toBe(true);
    expect(p.reason).toMatch(/Frame took/);
  });

  it("does not panic when still above the scale floor", () => {
    const p = new PerfMonitor(1.0, { warmupFrames: 0, panicMs: 500 });
    const obs = p.observe(800, 16.6);
    expect(obs.paused).toBe(false);
  });

  it("ignores a single giant dt (backgrounded tab)", () => {
    const p = new PerfMonitor(1.0, { warmupFrames: 0, skipIfDtOverMs: 250 });
    const before = p.renderScale;
    p.observe(800, 5000); // one 5-second gap
    expect(p.renderScale).toBe(before);
  });

  it("resume clears the paused flag and streaks", () => {
    const p = new PerfMonitor(0.25, { warmupFrames: 0, panicMs: 500, minScale: 0.25 });
    p.observe(800, 16.6);
    expect(p.paused).toBe(true);
    p.resume();
    expect(p.paused).toBe(false);
    expect(p.reason).toBe("");
  });
});
