// scripts/debug-download.cjs
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const TEST_DIR = path.resolve(__dirname, '..', 'test-fetch-debug');
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli', 'fetch-fixtures.js');

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(FIXTURES_DIR, urlPath.replace(/^\/+/, ''));
  console.log(`  [server] ${req.method} ${req.url} -> ${path.basename(filePath)}`);
  if (!filePath.startsWith(FIXTURES_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.log(`  [server] 404 ${urlPath}`);
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
  console.log(`Server: ${baseUrl}\n`);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  try {
    const out = execFileSync(process.execPath, [CLI_PATH, '--yes', '--to', TEST_DIR, '--base', baseUrl], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log('STDOUT:');
    console.log(out);
  } catch (e) {
    console.log('STDOUT:');
    console.log(e.stdout || '(empty)');
    console.log('STDERR:');
    console.log(e.stderr || '(empty)');
    console.log('Exit:', e.status);
  }

  server.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});