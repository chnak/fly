// scripts/debug-spawn.cjs — async spawn test
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const TEST_DIR = path.resolve(__dirname, '..', 'test-fetch-debug');
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli', 'fetch-fixtures.js');

const server = http.createServer((req, res) => {
  console.log(`[server] ${req.method} ${req.url}`);
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
  console.log(`Server: ${baseUrl}\n`);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const child = spawn(process.execPath, [
    CLI_PATH,
    '--yes',
    '--to', TEST_DIR,
    '--base', baseUrl
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', d => process.stdout.write('[child STDOUT] ' + d));
  child.stderr.on('data', d => process.stderr.write('[child STDERR] ' + d));

  child.on('exit', (code, sig) => {
    console.log(`\n[child EXIT] code=${code} signal=${sig}`);
    server.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.exit(0);
  });

  // safety timeout
  setTimeout(() => {
    console.log('\n[TIMEOUT] killing child');
    child.kill();
  }, 20000);
});