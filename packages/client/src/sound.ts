/**
 * Sound effects: a thin WebAudio layer over the Kenney audio packs.
 * Variants per effect are picked at random; positional plays attenuate with
 * distance from the camera. The AudioContext can only start after a user
 * gesture, so `unlock()` is wired to the first input event.
 */

const KINDS = {
  fire: ['fire0', 'fire1', 'fire2'],
  boom: ['boom0', 'boom1', 'boom2'],
  bigboom: ['bigboom0', 'bigboom1'],
  error: ['error0'],
  capture: ['capture0'],
  click: ['click0'],
} as const;

export type SoundKind = keyof typeof KINDS;

/** positional sounds fade to silence at this distance (tiles from camera) */
const EARSHOT = 26;

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = false;
  muted = localStorage.getItem('atbolo-muted') === '1';

  /** Call from a user-gesture handler; creates the context and loads files. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return; // no audio support; stay silent
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    if (!this.loading) {
      this.loading = true;
      for (const names of Object.values(KINDS)) {
        for (const name of names) {
          void fetch(`/assets/sfx/${name}.ogg`)
            .then((r) => r.arrayBuffer())
            .then((data) => this.ctx!.decodeAudioData(data))
            .then((buf) => this.buffers.set(name, buf))
            .catch(() => {});
        }
      }
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('atbolo-muted', this.muted ? '1' : '0');
    return this.muted;
  }

  /**
   * Play an effect. With `at` + `ear` (world coords), volume falls off with
   * distance and silence beyond EARSHOT; without, it plays at full volume.
   */
  play(kind: SoundKind, opts: { volume?: number; at?: { x: number; y: number }; ear?: { x: number; y: number } } = {}): void {
    if (this.muted || !this.ctx || !this.master) return;
    let vol = opts.volume ?? 1;
    if (opts.at && opts.ear) {
      const d = Math.hypot(opts.at.x - opts.ear.x, opts.at.y - opts.ear.y);
      if (d >= EARSHOT) return;
      vol *= 1 - (d / EARSHOT) ** 1.4;
    }
    if (vol <= 0.01) return;
    const names = KINDS[kind];
    const buf = this.buffers.get(names[Math.floor(Math.random() * names.length)]);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = vol;
    src.connect(gain);
    gain.connect(this.master);
    src.start();
  }
}
