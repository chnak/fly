#!/usr/bin/env node
    // examples/11-screen-fly/launch.ts
    // 一键启动：起 HTTP 服务 + 自动打开浏览器
    // 用法：node --experimental-strip-types --no-warnings examples/11-screen-fly/launch.ts [port]
    
    import { createServer } from 'node:http';
    import { readFile, stat } from 'node:fs/promises';
    import { join, extname, dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { spawn } from 'node:child_process';
    
    const PORT = parseInt(process.argv[2] || '4321', 10);
    const HOST = '127.0.0.1';
    
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const ROOT = __dirname;
    
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png':  'image/png',
      '.svg':  'image/svg+xml',
    };
    
    const server = createServer(async (req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const fp = join(ROOT, urlPath);
      try {
        const st = await stat(fp);
        if (!st.isFile()) throw new Error('not file');
        const body = await readFile(fp);
        res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 not found: ' + urlPath);
      }
    });
    
    server.listen(PORT, HOST, () => {
      const url = `http://${HOST}:${PORT}/`;
      console.log(`蝇脑已启动: ${url}`);
      console.log('按 Ctrl+C 退出');
      // 自动打开浏览器
      const opener =
        process.platform === 'win32'  ? `start "" "${url}"` :
        process.platform === 'darwin' ? `open "${url}"` :
                                        `xdg-open "${url}"`;
      spawn(opener, { shell: true, stdio: 'ignore', windowsHide: true });
    });
    
    process.on('SIGINT',  () => { console.log('\n退出'); server.close(); process.exit(0); });
    process.on('SIGTERM', () => { server.close(); process.exit(0); });
    