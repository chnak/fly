import { readFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { BrainManifest } from './types.js';

const gunzipAsync = promisify(gunzip);

export interface Meta {
  n: number;
  types: string[];
  superclasses: string[];
  params: { dt: number; tau: number; gain: number; tonic: number; noise_hz: number; noise_amp: number };
  typeIdx: Uint16Array;
  classIdx: Uint8Array;
  side: Uint8Array;
}

export interface ConnectomeWeights {
  n: number;
  nnz: number;
  colPtr: Uint32Array;
  rowIdx: Uint32Array;
  code: Uint8Array;
  lut: Float32Array;
}

export interface ConnectomeLoadOptions {
  metaPath: string;
  weightsPaths: string[];
  manifest: BrainManifest;
  /** Optional progress reporter 0..1 across all weight chunks. */
  onProgress?: (fraction: number) => void;
}

export interface Connectome {
  meta: Meta;
  weights: ConnectomeWeights;
  manifest: BrainManifest;
  /** Neuron index lookup by name (+ optional side). */
  cells(name: string, side?: 'L' | 'R'): Int32Array;
  /** Feature expansion for the readout model (e.g. "TARGET_DN L" -> cell union). */
  featureCells(feature: string): Int32Array;
  dispose(): void;
}

function magic(view: DataView, want: string): void {
  const got = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (got !== want) throw new Error(`Expected ${want}, got ${got}`);
}

export function parseMeta(buf: ArrayBuffer): Meta {
  const view = new DataView(buf);
  magic(view, 'FLYM');
  const n = view.getUint32(8, true);
  const len = view.getUint32(12, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, len)));
  let at = 16 + len;
  const typeIdx = new Uint16Array(buf.slice(at, at + 2 * n));
  at += 2 * n;
  const classIdx = new Uint8Array(buf, at, n);
  at += n;
  return { n, types: head.types, superclasses: head.superclasses, params: head.params, typeIdx, classIdx, side: new Uint8Array(buf, at, n) };
}

export function parseWeights(buf: ArrayBuffer): ConnectomeWeights {
  const view = new DataView(buf);
  magic(view, 'FLYW');
  const n = view.getUint32(8, true);
  const nnz = view.getUint32(12, true);
  const lnMin = view.getFloat32(16, true);
  const bytes = new Uint8Array(buf);
  let at = 20;
  const varint = (): number => {
    let x = 0;
    let shift = 0;
    let b = 0;
    do {
      b = bytes[at++];
      x += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return x;
  };
  const colPtr = new Uint32Array(n + 1);
  for (let j = 0; j < n; j++) colPtr[j + 1] = colPtr[j] + varint();
  const rowIdx = new Uint32Array(nnz);
  for (let j = 0; j < n; j++) {
    let row = 0;
    for (let e = colPtr[j], first = true; e < colPtr[j + 1]; e++, first = false) {
      row = first ? varint() : row + varint();
      rowIdx[e] = row;
    }
  }
  const code = bytes.slice(at, at + nnz);
  const lut = new Float32Array(256);
  for (let q = 0; q < 128; q++) {
    const mag = Math.exp(lnMin * (1 - q / 127));
    lut[q] = mag;
    lut[q | 128] = -mag;
  }
  return { n, nnz, colPtr, rowIdx, code, lut };
}

/** Auto-detect gzip vs raw by magic bytes (single file). */
async function readMaybeGzipped(path: string): Promise<ArrayBuffer> {
  const buf = await readFile(path);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const out = await gunzipAsync(buf);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * Read all weights parts and produce a single FLYW-shaped ArrayBuffer.
 *
 * The official browser export stores each `weights.0.bin`, `weights.1.bin`, ...
 * as a *fragment* of one gzip stream. Concatenating the raw bytes gives a
 * valid gzip file; gunzipping it once yields the complete CSR buffer.
 *
 * Legacy layouts where each part is its own (uncompressed) FLYW chunk are
 * still supported: in that case no gzip header is present and we just
 * concatenate the raw bytes.
 */
async function readAllWeightsParts(paths: string[], onProgress?: (fraction: number) => void): Promise<ArrayBuffer> {
  const sizes = await Promise.all(paths.map(async (p) => (await readFile(p)).length));
  const total = sizes.reduce((a, c) => a + c, 0);
  const chunks: Buffer[] = [];
  let got = 0;
  for (const p of paths) {
    const buf = await readFile(p);
    chunks.push(buf);
    got += buf.length;
    onProgress?.(Math.min(1, got / Math.max(1, total)));
  }
  const merged = Buffer.concat(chunks, got);
  if (merged.length >= 2 && merged[0] === 0x1f && merged[1] === 0x8b) {
    const out = await gunzipAsync(merged);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }
  const ab = new ArrayBuffer(merged.byteLength);
  new Uint8Array(ab).set(merged);
  return ab;
}

const FEATURE_SETS: Record<string, string[]> = {
  TARGET_DN: ['DNae002', 'DNae001', 'DNg111', 'DNge109', 'DNb01', 'DNg13', 'DNge103', 'DNp54'],
  LOOM_DN: ['DNa07', 'DNae004', 'DNg40', 'DNp04', 'DNp06', 'DNp103', 'DNp34', 'DNp35', 'DNp71', 'DNpe025', 'DNpe045', 'DNpe056'],
  ESCAPE_DN: ['DNp01', 'DNp04', 'DNg40', 'DNp71']
};

function makeCellsLookup(meta: Meta): (name: string, side?: 'L' | 'R') => Int32Array {
  return function cells(name: string, side?: 'L' | 'R'): Int32Array {
    const th = meta.types.map((t) => t === name);
    const ch = meta.superclasses.map((t) => t === name);
    const s = side === 'L' ? 1 : side === 'R' ? 2 : 0;
    const out: number[] = [];
    for (let i = 0; i < meta.n; i++) {
      if ((th[meta.typeIdx[i]] || ch[meta.classIdx[i]]) && (!s || meta.side[i] === s)) out.push(i);
    }
    return Int32Array.from(out);
  };
}

function makeFeatureCells(meta: Meta, cells: (name: string, side?: 'L' | 'R') => Int32Array): (feature: string) => Int32Array {
  return function featureCells(feature: string): Int32Array {
    const m = feature.match(/^(.*) ([lr])$/i);
    if (!m) return cells(feature);
    const side = (m[2].toUpperCase() === 'L' ? 'L' : 'R') as 'L' | 'R';
    const names = FEATURE_SETS[m[1]];
    if (!names) return cells(m[1], side);
    const all: number[] = [];
    for (const name of names) for (const id of cells(name, side)) all.push(id);
    return Int32Array.from(new Set(all));
  };
}

export async function loadConnectome(opts: ConnectomeLoadOptions): Promise<Connectome> {
  const meta = parseMeta(await readMaybeGzipped(opts.metaPath));
  const mergedWeights = await readAllWeightsParts(opts.weightsPaths, opts.onProgress);
  const weights = parseWeights(mergedWeights);
  if (meta.n !== opts.manifest.neurons || weights.n !== opts.manifest.neurons || weights.nnz !== opts.manifest.connections) {
    throw new Error(`fly.ai export integrity check failed (expected ${opts.manifest.neurons.toLocaleString()} neurons / ${opts.manifest.connections.toLocaleString()} connections)`);
  }
  const cells = makeCellsLookup(meta);
  const featureCells = makeFeatureCells(meta, cells);
  return {
    meta,
    weights,
    manifest: opts.manifest,
    cells,
    featureCells,
    dispose() {
      /* typed arrays are GC-managed; nothing to free explicitly */
    }
  };
}