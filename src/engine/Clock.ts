export class Clock {
  private last = performance.now();
  dt = 0;
  time = 0;
  frame = 0;
  private emaFrameMs = 16.6;

  tick(): void {
    const now = performance.now();
    const dtMs = now - this.last;
    this.last = now;
    this.dt = dtMs / 1000;
    this.time += this.dt;
    this.frame += 1;
    const a = 0.1;
    this.emaFrameMs = this.emaFrameMs * (1 - a) + dtMs * a;
  }

  get fps(): number {
    return 1000 / this.emaFrameMs;
  }

  get frameMs(): number {
    return this.emaFrameMs;
  }
}
