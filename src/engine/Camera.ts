import type { Input } from "./Input";
import { clamp, normalize, toRadians, type Vec3 } from "../util/math";

export class Camera {
  position: Vec3 = [0, 1.5, 5];
  yaw = Math.PI; // look toward -Z by default
  pitch = 0;
  fovY = toRadians(60);
  near = 0.05;
  far = 500;
  moveSpeed = 4;
  sprintMultiplier = 4;
  mouseSensitivity = 0.0025;

  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return normalize([Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp]);
  }

  right(): Vec3 {
    return normalize([Math.cos(this.yaw), 0, Math.sin(this.yaw)]);
  }

  up(): Vec3 {
    return [0, 1, 0];
  }

  update(input: Input, dt: number): void {
    const m = input.consumeMouse();
    this.yaw += m.dx * this.mouseSensitivity;
    this.pitch -= m.dy * this.mouseSensitivity;
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

    const speed = this.moveSpeed * (input.held("ShiftLeft") || input.held("ShiftRight") ? this.sprintMultiplier : 1);
    const f = this.forward();
    const r = this.right();
    let vx = 0, vy = 0, vz = 0;
    if (input.held("KeyW")) { vx += f[0]; vy += f[1]; vz += f[2]; }
    if (input.held("KeyS")) { vx -= f[0]; vy -= f[1]; vz -= f[2]; }
    if (input.held("KeyD")) { vx += r[0]; vy += r[1]; vz += r[2]; }
    if (input.held("KeyA")) { vx -= r[0]; vy -= r[1]; vz -= r[2]; }
    if (input.held("Space")) { vy += 1; }
    if (input.held("ControlLeft") || input.held("ControlRight")) { vy -= 1; }

    const len = Math.hypot(vx, vy, vz);
    if (len > 1e-6) {
      const s = (speed * dt) / len;
      this.position[0] += vx * s;
      this.position[1] += vy * s;
      this.position[2] += vz * s;
    }
  }
}
