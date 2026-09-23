// scripts/test-cli.cjs — test CLI commands
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cliPath = path.resolve(__dirname, '..', 'dist', 'cli', 'fetch-fixtures.js');

function runCli(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

// Test 1: --help
console.log('=== Test 1: --help ===');
let r = runCli(['--help']);
console.log('OK:', r.ok);
console.log(r.out.split('\n').slice(0, 5).join('\n'));
console.log('...');
console.log(r.out.split('\n').slice(-3).join('\n'));

// Test 2: --check (fixtures already exist in repo)
console.log('\n=== Test 2: --check (existing ./fixtures) ===');
r = runCli(['--check', '--to', './fixtures']);
console.log('OK:', r.ok);
console.log(r.out);

// Test 3: --check on empty dir
console.log('\n=== Test 3: --check on empty ./test-empty-dir ===');
fs.mkdirSync('./test-empty-dir', { recursive: true });
r = runCli(['--check', '--to', './test-empty-dir']);
console.log('OK:', r.ok);
console.log(r.out);

// Test 4: invalid flag
console.log('\n=== Test 4: invalid flag --bogus ===');
r = runCli(['--bogus']);
console.log('OK (expect false):', r.ok);
console.log(r.out);