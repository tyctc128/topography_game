/** One Euro Filter：慢慢動時很穩、快速動時跟得上。 */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, tSec: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = tSec;
      return value;
    }
    const dt = Math.max(1e-3, tSec - this.t);
    this.t = tSec;
    const dxRaw = (value - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}
