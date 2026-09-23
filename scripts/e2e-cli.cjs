// scripts/e2e-cli.cjs — full E2E test of fly-fetch CLI without needing GitHub
const { execFileSync, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const TEST_DIR = path.resolve(__dirname, '..', 'test-fetch-tmp');
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli', 'fetch-fixtures.js');

console.log('=== E2E test of fly-fetch CLI ===\n');

// 1. Start a local HTTP server serving the fixtures dir
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/checksums.json';
  const filePath = path.join(FIXTURES_DIR, urlPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(FIXTURES_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Local server: ${baseUrl}\n`);

  function run(args, opts = {}) {
    try {
      const out = execFileSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.resolve(__dirname, '..')
      });
      return { ok: true, out };
    } catch (e) {
      return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status };
    }
  }

  // Clean test dir
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Test A: --check on empty dir
  console.log('--- Test A: --check on empty dir ---');
  let r = run(['--check', '--to', TEST_DIR, '--base', baseUrl]);
  console.log('  ok:', r.ok, '(expect false — files missing)');
  console.log('  exit:', r.code);
  console.log(r.out.split('\n').map(l => '  | ' + l).join('\n'));
  console.log();

  // Test B: full download
  console.log('--- Test B: full download ---');
  r = run(['--yes', '--to', TEST_DIR, '--base', baseUrl]);
  console.log('  ok:', r.ok, '(expect true)');
  console.log(r.out.split('\n').slice(0, 25).map(l => '  | ' + l).join('\n'));
  console.log('  ...');
  console.log();

  // Test C: verify size
  console.log('--- Test C: verify downloaded files ---');
  const expected = [
    'brain.json', 'meta.bin', 'readout.json', 'readout.trained.json',
    'readout.trial-and-error.json', 'weights.0.bin', 'weights.1.bin'
  ];
  let allOk = true;
  for (const f of expected) {
    const got = fs.statSync(path.join(TEST_DIR, f)).size;
    const expSize = fs.statSync(path.join(FIXTURES_DIR, f)).size;
    const ok = got === expSize;
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✓' : '✗'}  ${f.padEnd(34)} ${String(got).padStart(10)} / ${expSize}`);
  }
  console.log();
  console.log(allOk ? '  ✓ all sizes match' : '  ✗ SIZE MISMATCH');
  console.log();

  // Test D: --check on downloaded dir
  console.log('--- Test D: --check on downloaded dir ---');
  r = run(['--check', '--to', TEST_DIR, '--base', baseUrl]);
  console.log('  ok:', r.ok, '(expect true)');
  console.log(r.out);
  console.log();

  // Test E: re-download (should skip)
  console.log('--- Test E: re-download (no --force, should skip) ---');
  r = run(['--yes', '--to', TEST_DIR, '--base', baseUrl]);
  console.log('  ok:', r.ok, '(expect true)');
  const skipLine = r.out.split('\n').find(l => l.includes('Nothing to do'));
  console.log('  skip msg:', skipLine || '(NOT FOUND)');
  console.log();

  // Test F: --force re-download
  console.log('--- Test F: --force re-download ---');
  r = run(['--yes', '--force', '--to', TEST_DIR, '--base', baseUrl]);
  console.log('  ok:', r.ok, '(expect true)');
  const dlLines = r.out.split('\n').filter(l => l.startsWith('  ↓')).length;
  console.log(`  downloaded: ${dlLines} files (expect 7)`);
  console.log();

  // Cleanup
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  server.close();

  console.log('=== E2E complete ===');
});