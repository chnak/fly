// scripts/cli-test.cjs
const { spawnSync } = require('child_process');
const path = require('path');

const cliPath = path.resolve('dist/cli/fetch-fixtures.js');
const args = process.argv.slice(2);

console.log(`Running: node ${cliPath} ${args.join(' ')}\n`);
console.log('='.repeat(70));

const r = spawnSync(process.execPath, [cliPath, ...args], {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: process.cwd()
});

console.log('STDOUT:');
console.log(r.stdout || '(empty)');
console.log();
console.log('STDERR:');
console.log(r.stderr || '(empty)');
console.log();
console.log('Exit code:', r.status);