export type DebugMode = "off" | "steps" | "normals";

export class Input {
  private keys = new Set<string>();
  private pointerLocked = false;
  dx = 0;
  dy = 0;
  scroll = 0;
  debug: DebugMode = "off";
  leftClick = false;
  rightClick = false;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Digit1") this.debug = this.debug === "off" ? "steps" : "off";
      if (e.code === "Digit2") this.debug = this.debug === "normals" ? "off" : "normals";
      if (e.code === "Digit3") this.debug = "off";
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    canvas.addEventListener("click", () => {
      if (!this.pointerLocked) canvas.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    window.addEventListener("mousemove", (e) => {
      if (this.pointerLocked) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.leftClick = true;
      if (e.button === 2) this.rightClick = true;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      this.scroll += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }

  held(code: string): boolean {
    return this.keys.has(code);
  }

  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return r;
  }

  consumeClicks(): { left: boolean; right: boolean } {
    const r = { left: this.leftClick, right: this.rightClick };
    this.leftClick = false;
    this.rightClick = false;
    return r;
  }
}
