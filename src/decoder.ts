import type { Decision } from './types.js';

/**
 * Pure-Brain decoder: counts DNp01 spikes over a rolling 100 ms window and
 * emits FLAP whenever the spike count crosses a threshold, gated by a cooldown.
 *
 * This is only meaningful for the unmodified MaleCNS connectome.
 */
export class FlyDecoder {
  private spikes: number[] = [];
  private lastFlap = -Infinity;

  constructor(private threshold = 2, private cooldown = 120) {}

  decide(now: number, spike: boolean): Decision {
    if (spike) this.spikes.push(now);
    this.spikes = this.spikes.filter((t) => now - t <= 100);
    if (this.spikes.length >= this.threshold && now - this.lastFlap >= this.cooldown) {
      this.lastFlap = now;
      this.spikes = [];
      return 'FLAP';
    }
    return 'WAIT';
  }

  reset() {
    this.spikes = [];
    this.lastFlap = -Infinity;
  }
}