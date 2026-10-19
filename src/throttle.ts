// Sliding-window counters, e.g. Mobbin code emails per address and per IP.
export class Throttle {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {
    setInterval(() => this.sweep(), windowMs).unref();
  }

  // Counts one hit for key; returns the seconds until the next hit is allowed, or 0 when this one is.
  take(key: string): number {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.ceil((recent[0] + this.windowMs - now) / 1000);
    }
    recent.push(now);
    this.hits.set(key, recent);
    return 0;
  }

  private sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.hits) if (times.every((t) => t <= cutoff)) this.hits.delete(key);
  }
}
