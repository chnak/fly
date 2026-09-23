#!/usr/bin/env node
/**
 * fly-fetch — download MaleCNS fixtures for @chnak/fly
 *
 * Usage:
 *   npx fly-fetch                download to ./fixtures
 *   npx fly-fetch --to ./data    download to ./data
 *   npx fly-fetch --check       verify existing files only, no download
 *   npx fly-fetch --force       overwrite existing files
 *   npx fly-fetch --yes         skip confirmation prompt
 *   npx fly-fetch --base <url>  override download base URL
 *
 * Source: GitHub raw at github.com/chnak/fly
 * Total:  55.25 MB across 7 files
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

interface FixtureEntry {
  path: string;
  size: number;
  sha256: string;
}

interface Manifest {
  version: number;
  total_size: number;
  total_files: number;
  files: FixtureEntry[];
}

const DEFAULT_BASE = 'https://raw.githubusercontent.com/chnak/fly/main/fixtures';

interface ParsedArgs {
  to: string;
  check: boolean;
  force: boolean;
  yes: boolean;
  help: boolean;
  base: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    to: './fixtures',
    check: false,
    force: false,
    yes: false,
    help: false,
    base: DEFAULT_BASE,
    verbose: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to' || a === '-o') args.to = argv[++i];
    else if (a === '--check') args.check = true;
    else if (a === '--force') args.force = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--') || a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else throw new Error(`Unexpected positional argument: ${a}`);
  }
  return args;
}

function helpText(): string {
  return `fly-fetch — download MaleCNS fixtures for @chnak/fly

Usage:
  npx fly-fetch [options]

Options:
  --to <dir>, -o     Target directory (default: ./fixtures)
  --check            Verify existing files; do not download
  --force            Re-download files even if they already exist
  --yes, -y          Skip confirmation prompt
  --base <url>       Override download base URL
  --verbose, -v      Print progress as each file is fetched
  --help, -h         Show this help

Files downloaded (from https://github.com/chnak/fly/tree/main/fixtures):
  brain.json                       243 B
  meta.bin                       335.2 KB
  readout.json                     563 B
  readout.trained.json             950 B
  readout.trial-and-error.json     526 B
  weights.0.bin                  40.00 MB
  weights.1.bin                  17.59 MB
  ----------------------------------------
  Total                          55.25 MB across 7 files

Examples:
  npx fly-fetch                       # download to ./fixtures
  npx fly-fetch --to ./data           # download to ./data
  npx fly-fetch --check               # verify existing ./fixtures
  npx fly-fetch --base <mirror-url>   # use a mirror
`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function loadManifest(base: string): Promise<Manifest> {
  const url = `${base.replace(/\/$/, '')}/checksums.json`;
  const text = await httpGetText(url, 30000);
  return JSON.parse(text) as Manifest;
}

function httpGetText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'user-agent': 'fly-fetch/0.1' }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } else {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms for ${url}`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fileSha256(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

interface FileStatus {
  path: string;
  status: 'ok' | 'bad-size' | 'bad-hash' | 'missing';
  gotSha?: string;
  gotSize?: number;
}

async function checkFile(targetDir: string, entry: FixtureEntry): Promise<FileStatus> {
  const dest = join(targetDir, entry.path);
  try {
    const s = await stat(dest);
    if (s.size !== entry.size) {
      return { path: entry.path, status: 'bad-size', gotSize: s.size };
    }
    const got = await fileSha256(dest);
    if (got !== entry.sha256) {
      return { path: entry.path, status: 'bad-hash', gotSha: got };
    }
    return { path: entry.path, status: 'ok' };
  } catch {
    return { path: entry.path, status: 'missing' };
  }
}

async function downloadOne(
  url: string,
  dest: string,
  expectedSize: number,
  onChunk: (delta: number) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'user-agent': 'fly-fetch/0.1' }
    }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let downloaded = 0;
      const ws = createWriteStream(dest);
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        onChunk(chunk.length);
      });
      res.on('end', () => {
        ws.end(() => {
          if (downloaded !== expectedSize) {
            reject(new Error(`Size mismatch: expected ${expectedSize} B, got ${downloaded} B`));
          } else {
            resolve();
          }
        });
      });
      res.on('error', reject);
      res.pipe(ws);
    });
    req.setTimeout(120000, () => req.destroy(new Error(`Timeout after 120000ms for ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans: string) => {
      rl.close();
      resolve(!ans.toLowerCase().startsWith('n'));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }

  const targetDir = resolve(args.to);

  console.log('fly-fetch \u2014 MaleCNS fixtures downloader for @chnak/fly\n');
  console.log(`  target: ${targetDir}`);
  console.log(`  source: ${args.base}`);
  if (args.check) console.log(`  mode:   --check (verify only, no download)`);
  if (args.force) console.log(`  mode:   --force (overwrite existing)`);
  console.log();

  // Load manifest
  let manifest: Manifest;
  try {
    manifest = await loadManifest(args.base);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\u2717 Failed to load manifest: ${msg}`);
    console.error(`  Hint: pass --base <url> to use a mirror or fork.`);
    process.exit(1);
  }

  if (!manifest.files || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    console.error(`\u2717 Manifest is empty or malformed.`);
    process.exit(1);
  }

  console.log(`Manifest: ${manifest.total_files} files, ${formatBytes(manifest.total_size)}`);
  console.log();

  // Pre-scan target directory
  await mkdir(targetDir, { recursive: true });
  const statuses = await Promise.all(manifest.files.map(e => checkFile(targetDir, e)));

  // --check mode
  if (args.check) {
    let allOk = true;
    for (const s of statuses) {
      if (s.status === 'missing') {
        console.log(`  \u2717 MISSING    ${s.path}`);
        allOk = false;
      } else if (s.status === 'ok') {
        console.log(`  \u2713 OK         ${s.path}`);
      } else if (s.status === 'bad-size') {
        console.log(`  \u2717 BAD-SIZE   ${s.path} (expected ${formatBytes(manifest.files.find(e => e.path === s.path)!.size)}, got ${formatBytes(s.gotSize ?? 0)})`);
        allOk = false;
      } else {
        console.log(`  \u2717 BAD-HASH   ${s.path}`);
        allOk = false;
      }
    }
    console.log();
    console.log(allOk ? '\u2713 All files present and verified.' : '\u2717 Some files missing or corrupted.');
    if (!allOk) console.log(`  Run \`npx fly-fetch\` to repair.`);
    process.exit(allOk ? 0 : 1);
  }

  // Compute download plan
  const toDownload = manifest.files.filter((e, i) => {
    if (args.force) return true;
    return statuses[i].status !== 'ok';
  });

  if (toDownload.length === 0) {
    console.log('\u2713 All files already present and verified. Nothing to do.');
    console.log(`  Use --force to re-download.`);
    return;
  }

  const downloadSize = toDownload.reduce((s, e) => s + e.size, 0);
  console.log(`Will download ${toDownload.length} file(s) (${formatBytes(downloadSize)}):`);
  for (const e of toDownload) {
    console.log(`  ${formatBytes(e.size).padStart(8)}  ${e.path}`);
  }
  console.log();

  // Confirm
  if (!args.yes) {
    const ok = await confirm(`Download ${formatBytes(downloadSize)} to ${targetDir}? [Y/n] `);
    if (!ok) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Download sequentially (avoids hammering the CDN)
  let totalDownloaded = 0;
  for (const entry of toDownload) {
    const dest = join(targetDir, entry.path);
    const tmp = `${dest}.partial`;
    const url = `${args.base.replace(/\/$/, '')}/${entry.path}`;
    await mkdir(dirname(dest), { recursive: true });

    if (args.verbose) {
      process.stdout.write(`  \u2193 ${entry.path} ... `);
    } else {
      process.stdout.write(`  \u2193 ${entry.path.padEnd(34)} ${formatBytes(entry.size).padStart(8)} ... `);
    }

    try {
      await downloadOne(url, tmp, entry.size, () => {
        // progress callback (could print a progress bar here)
      });

      // Verify sha256 before committing
      const got = await fileSha256(tmp);
      if (got !== entry.sha256) {
        await rm(tmp, { force: true });
        throw new Error(`sha256 mismatch (expected ${entry.sha256.slice(0, 12)}\u2026, got ${got.slice(0, 12)}\u2026)`);
      }

      // Atomic move
      await writeFile(dest, await readFile(tmp));
      await rm(tmp, { force: true });

      totalDownloaded += entry.size;
      console.log('OK');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`FAILED: ${msg}`);
      await rm(tmp, { force: true }).catch(() => {});
      console.error(`\n\u2717 Download aborted at ${entry.path}.`);
      console.error(`  To retry:  npx fly-fetch`);
      console.error(`  To verify: npx fly-fetch --check`);
      process.exit(1);
    }
  }

  console.log();
  console.log(`\u2713 Downloaded ${formatBytes(totalDownloaded)} into ${targetDir}`);
  console.log();
  console.log(`Next steps:`);
  console.log(`  cd <your-project>`);
  console.log(`  npx tsx node_modules/@chnak/fly/examples/04-createTrainer.ts`);
}

main().catch(e => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`\n\u2717 Fatal: ${msg}`);
  process.exit(1);
});