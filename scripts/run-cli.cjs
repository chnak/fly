// Just exec the CLI and redirect to a log file
const { execFileSync } = require('child_process');
const fs = require('fs');

const cliPath = 'D:\\Date\\20260808\\fly\\dist\\cli\\fetch-fixtures.js';
const args = process.argv.slice(2);

try {
  const out = execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  fs.writeFileSync('cli-output.txt', 'STDOUT:\n' + out);
} catch (e) {
  fs.writeFileSync('cli-output.txt',
    'STDOUT:\n' + (e.stdout || '(empty)') +
    '\n\nSTDERR:\n' + (e.stderr || '(empty)') +
    '\n\nExit code: ' + e.status);
}
console.log('Wrote cli-output.txt');