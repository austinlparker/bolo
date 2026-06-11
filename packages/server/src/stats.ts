/**
 * Balance-telemetry sink: batches sim StatEvents and ships them to the
 * Honeycomb events API. A no-op unless HONEYCOMB_API_KEY is set (wrangler
 * secret), so local dev and keyless deploys cost nothing.
 */

const FLUSH_AT = 100; // events
const ENDPOINT = 'https://api.honeycomb.io/1/batch/';

export class StatsSink {
  private buf: { time: string; data: Record<string, unknown> }[] = [];

  constructor(
    private apiKey: string | undefined,
    private dataset: string,
  ) {}

  get enabled(): boolean {
    return !!this.apiKey;
  }

  push(fields: Record<string, unknown>): void {
    if (!this.apiKey) return;
    // drop undefined fields so events stay lean
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) data[k] = v;
    this.buf.push({ time: new Date().toISOString(), data });
    if (this.buf.length >= FLUSH_AT) this.flush();
  }

  /** Fire-and-forget; events are tuning data, losing a batch is acceptable. */
  flush(): void {
    if (!this.apiKey || this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    void fetch(ENDPOINT + encodeURIComponent(this.dataset), {
      method: 'POST',
      headers: { 'X-Honeycomb-Team': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    }).catch(() => {});
  }
}
