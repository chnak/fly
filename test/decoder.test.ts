import { describe, expect, it } from 'vitest';
import { FlyDecoder } from '../src/decoder.js';

describe('FlyDecoder', () => {
  it('emits FLAP after enough spikes within window', () => {
    const d = new FlyDecoder(2, 100);
    expect(d.decide(0, true)).toBe('WAIT');
    expect(d.decide(50, true)).toBe('FLAP');
    expect(d.decide(60, false)).toBe('WAIT');
  });

  it('respects cooldown', () => {
    const d = new FlyDecoder(1, 100);
    expect(d.decide(0, true)).toBe('FLAP');
    expect(d.decide(50, true)).toBe('WAIT');
    expect(d.decide(150, true)).toBe('FLAP');
  });

  it('drops spikes outside the 100ms window', () => {
    const d = new FlyDecoder(2, 0);
    d.decide(0, true);
    d.decide(50, true);
    expect(d.decide(200, false)).toBe('WAIT');
  });
});