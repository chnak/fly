// scripts/e2e-cli.cjs — full E2E test of fly-fetch CLI (async)
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const TEST_DIR = path.resolve(__dirname, '..', 'test-fetch-tmp');
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli', 'fetch-fixtures.js');

function runCli(args, baseUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      CLI_PATH, ...args, '--base', baseUrl
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('exit', code => resolve({ code, stdout, stderr }));

    setTimeout(() => { child.kill(); resolve({ code: -1, stdout, stderr, killed: true }); }, 120000);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const filePath = path.join(FIXTURES_DIR, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200); res.end(data);
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`=== E2E test of fly-fetch CLI ===\nLocal server: ${baseUrl}\n`);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const expected = [
    'brain.json', 'meta.bin', 'readout.json', 'readout.trained.json',
    'readout.trial-and-error.json', 'weights.0.bin', 'weights.1.bin'
  ];

  let passed = 0, failed = 0;

  // Test A: --check on empty dir
  console.log('--- Test A: --check on empty dir ---');
  let r = await runCli(['--check', '--to', TEST_DIR], baseUrl);
  console.log(`  exit code: ${r.code} (expect 1)`);
  const aOk = r.code === 1;
  console.log(`  ${aOk ? '✓' : '✗'} ${aOk ? 'PASS' : 'FAIL'}\n`);
  if (aOk) passed++; else failed++;

  // Test B: full download
  console.log('--- Test B: full download (--yes) ---');
  r = await runCli(['--yes', '--to', TEST_DIR], baseUrl);
  console.log(`  exit code: ${r.code} (expect 0)`);
  const dlLines = r.stdout.split('\n').filter(l => l.startsWith('  ↓')).length;
  console.log(`  downloaded: ${dlLines} files (expect 7)`);
  const bOk = r.code === 0 && dlLines === 7;
  console.log(`  ${bOk ? '✓' : '✗'} ${bOk ? 'PASS' : 'FAIL'}\n`);
  if (bOk) passed++; else failed++;

  // Test C: verify file sizes + sha256
  console.log('--- Test C: verify sizes + sha256 ---');
  let cOk = true;
  const crypto = require('crypto');
  for (const f of expected) {
    const p = path.join(TEST_DIR, f);
    if (!fs.existsSync(p)) { console.log(`  ✗ missing ${f}`); cOk = false; continue; }
    const got = fs.statSync(p).size;
    const expSize = fs.statSync(path.join(FIXTURES_DIR, f)).size;
    const gotSha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const expSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURES_DIR, f))).digest('hex');
    const ok = got === expSize && gotSha === expSha;
    if (!ok) cOk = false;
    console.log(`  ${ok ? '✓' : '✗'} ${f.padEnd(34)} ${String(got).padStart(10)} B  sha=${gotSha.slice(0,12)}…`);
  }
  console.log(`  ${cOk ? '✓ PASS' : '✗ FAIL'}\n`);
  if (cOk) passed++; else failed++;

  // Test D: --check on downloaded dir
  console.log('--- Test D: --check on downloaded dir ---');
  r = await runCli(['--check', '--to', TEST_DIR], baseUrl);
  console.log(`  exit code: ${r.code} (expect 0)`);
  const dOk = r.code === 0;
  console.log(`  ${dOk ? '✓' : '✗'} ${dOk ? 'PASS' : 'FAIL'}\n`);
  if (dOk) passed++; else failed++;

  // Test E: re-download (no --force, should skip)
  console.log('--- Test E: re-download (no --force) ---');
  r = await runCli(['--yes', '--to', TEST_DIR], baseUrl);
  const skipLine = r.stdout.split('\n').find(l => l.includes('Nothing to do'));
  const eOk = r.code === 0 && !!skipLine;
  console.log(`  exit code: ${r.code} (expect 0)`);
  console.log(`  skip msg: ${skipLine ? 'present' : 'MISSING'}`);
  console.log(`  ${eOk ? '✓' : '✗'} ${eOk ? 'PASS' : 'FAIL'}\n`);
  if (eOk) passed++; else failed++;

  // Test F: --force re-download
  console.log('--- Test F: --force re-download ---');
  r = await runCli(['--yes', '--force', '--to', TEST_DIR], baseUrl);
  const dlLines2 = r.stdout.split('\n').filter(l => l.startsWith('  ↓')).length;
  const fOk = r.code === 0 && dlLines2 === 7;
  console.log(`  exit code: ${r.code} (expect 0)`);
  console.log(`  downloaded: ${dlLines2} files (expect 7)`);
  console.log(`  ${fOk ? '✓' : '✗'} ${fOk ? 'PASS' : 'FAIL'}\n`);
  if (fOk) passed++; else failed++;

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  server.close();

  console.log('=== Summary ===');
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
});