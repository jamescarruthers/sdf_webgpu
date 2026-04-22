// Adaptive render-scale watchdog.
//
// Observes each frame's wall time and trims the internal backbuffer when
// frames get slow, so high-DPI or high-resolution displays don't lock up the
// browser tab waiting on a shader that pushes Chrome past its GPU timeout.
// When the scale is already at the floor and frames are still catastrophic,
// the watchdog pauses the render loop and surfaces a recoverable message.
//
// Hysteresis is deliberate: scale only moves after a streak so transient
// stalls (first frame, alt-tab, a big streaming burst) don't snowball into
// permanent resolution loss.

export interface PerfMonitorConfig {
  /** Lower bound for the adaptive render scale. 0.25 means 1/4 per-axis ≈
   *  1/16 of the native pixel count. */
  minScale: number;
  /** Upper bound — usually 1 for "native", rarely higher for supersampling. */
  maxScale: number;
  /** Frame time (ms) above which we start counting bad frames. */
  highWaterMs: number;
  /** Frame time (ms) below which we count good frames toward a scale-up. */
  lowWaterMs: number;
  /** Consecutive bad frames before shrinking scale by one step. */
  badStreakToShrink: number;
  /** Consecutive good frames before growing scale by one step. */
  goodStreakToGrow: number;
  /** A single frame exceeding this triggers an immediate emergency pause
   *  when scale is already at the floor. Chrome's GPU watchdog kills
   *  shaders around 2–3 s, so we want to bail well before that. */
  panicMs: number;
  /** Initial frames to ignore (shader compile, atlas warm-up, etc.). */
  warmupFrames: number;
  /** Single-frame dt over this threshold means the tab was backgrounded
   *  or the user was in devtools — don't count it. */
  skipIfDtOverMs: number;
}

export const DEFAULT_PERF_CONFIG: PerfMonitorConfig = {
  minScale: 0.25,
  maxScale: 1.0,
  highWaterMs: 33, // below ~30 fps
  lowWaterMs: 12, // above ~80 fps
  badStreakToShrink: 6,
  goodStreakToGrow: 120,
  panicMs: 500,
  warmupFrames: 10,
  skipIfDtOverMs: 250,
};

export interface PerfObservation {
  scaleChanged: boolean;
  paused: boolean;
  reason?: string;
}

export class PerfMonitor {
  readonly config: PerfMonitorConfig;
  renderScale: number;
  paused = false;
  reason = "";

  private frames = 0;
  private badStreak = 0;
  private goodStreak = 0;

  constructor(initialScale = 1.0, config: Partial<PerfMonitorConfig> = {}) {
    this.config = { ...DEFAULT_PERF_CONFIG, ...config };
    this.renderScale = Math.max(this.config.minScale, Math.min(this.config.maxScale, initialScale));
  }

  /**
   * Picks a safe starting scale for the given viewport so we don't hand the
   * GPU a 4K × 160-step first frame before the watchdog has any data.
   */
  static initialScaleForViewport(
    clientWidth: number,
    clientHeight: number,
    devicePixelRatio: number,
    targetPixels = 2_300_000, // ≈ 1080p
  ): number {
    const dpr = Math.min(Math.max(devicePixelRatio, 1), 2);
    const px = Math.max(1, clientWidth * clientHeight * dpr * dpr);
    if (px <= targetPixels) return 1.0;
    // scale² · px = target → scale = sqrt(target/px)
    const s = Math.sqrt(targetPixels / px);
    // Snap to a 0.05 step so adaptive moves later don't churn.
    return Math.max(0.25, Math.round(s * 20) / 20);
  }

  observe(frameMs: number, dtMs: number): PerfObservation {
    this.frames++;
    if (this.paused) return { scaleChanged: false, paused: true, reason: this.reason };
    if (this.frames <= this.config.warmupFrames) return { scaleChanged: false, paused: false };
    if (dtMs > this.config.skipIfDtOverMs) {
      // Tab was probably hidden; don't let a giant gap deform the streaks.
      this.badStreak = 0;
      this.goodStreak = 0;
      return { scaleChanged: false, paused: false };
    }

    // Hard panic — a single frame this slow is almost certainly on a path to
    // Chrome's GPU watchdog killing the context.
    if (frameMs > this.config.panicMs && this.renderScale <= this.config.minScale + 1e-3) {
      this.paused = true;
      this.reason =
        `Frame took ${frameMs.toFixed(0)} ms at minimum render scale (${(this.renderScale * 100).toFixed(0)}%).\n` +
        `Rendering paused to prevent the browser tab from freezing.\n\n` +
        `Press R to resume, or reload to reset.`;
      return { scaleChanged: false, paused: true, reason: this.reason };
    }

    if (frameMs > this.config.highWaterMs) {
      this.badStreak++;
      this.goodStreak = 0;
      if (this.badStreak >= this.config.badStreakToShrink) {
        this.badStreak = 0;
        if (this.renderScale > this.config.minScale + 1e-3) {
          const next = Math.max(this.config.minScale, this.renderScale * 0.75);
          this.renderScale = Math.round(next * 100) / 100;
          return { scaleChanged: true, paused: false };
        }
        // At floor; if it's sustained over the panic threshold, bail.
        if (frameMs > this.config.panicMs * 0.5) {
          this.paused = true;
          this.reason =
            `Sustained ${frameMs.toFixed(0)} ms frames at minimum render scale.\n` +
            `Rendering paused.\n\n` +
            `Press R to resume, or reload to reset.`;
          return { scaleChanged: false, paused: true, reason: this.reason };
        }
      }
    } else if (frameMs < this.config.lowWaterMs) {
      this.goodStreak++;
      this.badStreak = 0;
      if (this.goodStreak >= this.config.goodStreakToGrow && this.renderScale < this.config.maxScale - 1e-3) {
        this.goodStreak = 0;
        const next = Math.min(this.config.maxScale, this.renderScale / 0.75);
        this.renderScale = Math.round(next * 100) / 100;
        return { scaleChanged: true, paused: false };
      }
    } else {
      // Inside the comfort band — decay the streaks so one slow frame
      // doesn't linger forever.
      this.badStreak = Math.max(0, this.badStreak - 1);
      this.goodStreak = Math.max(0, this.goodStreak - 1);
    }
    return { scaleChanged: false, paused: false };
  }

  resume(): void {
    this.paused = false;
    this.reason = "";
    this.badStreak = 0;
    this.goodStreak = 0;
    this.frames = 0; // re-warmup
  }
}
