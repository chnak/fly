#!/usr/bin/env node
/**
 * bin/fly-daemon.ts
 *
 * Fly Brain 学习交易服务 — 后台守护进程管理
 *
 *  用法：
 *    fly-daemon start    后台启动 fly-server（写 PID 文件）
 *    fly-daemon stop     停止后台 fly-server（发 SIGTERM）
 *    fly-daemon status   显示 PID / 内存占用 / HTTP 健康
 *    fly-daemon logs     tail -f 学习日志
 *
 *  PID 文件：./data/fly.pid
 *  STDOUT：  ./data/fly.out
 *  STDERR：  ./data/fly.err
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

// Minimal .env loader (no dotenv dependency)
import { readFileSync } from 'node:fs';
try {
  const raw = readFileSync(resolve(projectRoot, '.env'), 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
} catch {}
const pidFile = resolve(projectRoot, 'data', 'fly.pid');
const outFile = resolve(projectRoot, 'data', 'fly.out');
const errFile = resolve(projectRoot, 'data', 'fly.err');

async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(pidFile, 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStart() {
  const existing = await readPid();
  if (existing && await isRunning(existing)) {
    console.log(`✗ fly-server 已在运行 (PID=${existing})`);
    console.log(`  查看：npm run fly:status`);
    console.log(`  停止：npm run fly:stop`);
    process.exit(1);
  }

  await mkdir(dirname(pidFile), { recursive: true });

  const logLevel = process.env.LOG_LEVEL || 'info';
  const env = { ...process.env, FORCE_COLOR: '1' };
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      resolve(projectRoot, 'src', 'fly-server.ts'),
    ],
    {
      cwd: projectRoot,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  // 重定向 stdout/stderr 到文件（追加模式）
  child.stdout?.on('data', (chunk) => appendFileSync(outFile, chunk));
  child.stderr?.on('data', (chunk) => appendFileSync(errFile, chunk));

  child.unref();

  // 写 PID
  if (child.pid) {
    await writeFile(pidFile, String(child.pid), 'utf-8');
  }

  console.log(`✓ fly-server 已在后台启动 (PID=${child.pid})`);
  console.log(`  STDOUT: ${outFile}`);
  console.log(`  STDERR: ${errFile}`);
  console.log(`  HTTP:   http://127.0.0.1:${process.env.FLY_PORT || 4333}/`);
  console.log(`  查看：npm run fly:status`);
  console.log(`  日志：npm run fly:logs`);
  console.log(`  停止：npm run fly:stop`);

  // 等待 1.5s 后用 health check 确认启动成功
  setTimeout(async () => {
    try {
      const port = parseInt(process.env.FLY_PORT || '4333', 10);
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const data = await res.json() as any;
        console.log(`\n✓ 健康检查通过 (uptime=${(data.uptimeMs/1000).toFixed(1)}s)`);
      } else {
        console.log(`\n⚠️  HTTP /api/health 返回 ${res.status}（服务可能还在启动）`);
      }
    } catch (e: any) {
      console.log(`\n⚠️  无法连接 HTTP: ${e.message}（服务可能还在启动，或端口被占用）`);
    }
    process.exit(0);
  }, 2500);
}

async function cmdStop() {
  const pid = await readPid();
  if (!pid) {
    console.log('✗ 未找到 PID 文件，服务可能未运行');
    process.exit(1);
  }
  if (!await isRunning(pid)) {
    console.log(`✗ PID=${pid} 不存在（清理陈旧 PID 文件）`);
    try {
      await writeFile(pidFile, '', 'utf-8');
    } catch {}
    process.exit(1);
  }

  console.log(`→ 停止 fly-server (PID=${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: any) {
    console.log(`  发送 SIGTERM 失败: ${e.message}`);
    process.exit(1);
  }

  // 等最多 8 秒
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!await isRunning(pid)) {
      console.log(`✓ 已停止 (PID=${pid})`);
      try { await writeFile(pidFile, '', 'utf-8'); } catch {}
      process.exit(0);
    }
  }

  console.log(`⚠ 服务未在 8 秒内退出，强制 SIGKILL`);
  try { process.kill(pid, 'SIGKILL'); } catch {}
  try { await writeFile(pidFile, '', 'utf-8'); } catch {}
  process.exit(0);
}

async function cmdStatus() {
  const pid = await readPid();
  if (!pid) {
    console.log('✗ fly-server 未运行（无 PID 文件）');
    console.log(`  启动：npm run fly:start`);
    process.exit(1);
  }
  if (!await isRunning(pid)) {
    console.log(`✗ PID=${pid} 不存在（陈旧 PID 文件）`);
    process.exit(1);
  }

  console.log(`✓ fly-server 运行中 (PID=${pid})`);

  // 尝试 HTTP health
  try {
    const port = parseInt(process.env.FLY_PORT || '4333', 10);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) {
      const data = await res.json() as any;
      console.log(`  HTTP:    正常 (uptime=${(data.uptimeMs/1000).toFixed(1)}s)`);
    } else {
      console.log(`  HTTP:    异常 ${res.status}`);
    }
  } catch (e: any) {
    console.log(`  HTTP:    无法连接 (${e.message})`);
  }

  // state
  try {
    const port = parseInt(process.env.FLY_PORT || '4333', 10);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    if (res.ok) {
      const s = await res.json() as any;
      console.log(`  阶段:    ${s.phase} (running=${s.running})`);
      console.log(`  P&L:     ${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)} (paper)`);
      console.log(`  Gen:     ${s.gen} (accept=${s.accepts}/${s.totalTries})`);
      console.log(`  持仓:    ${s.position === 1 ? 'LONG @ $' + s.entryPrice.toFixed(2) : '空仓'}`);
      console.log(`  最新K线: ${s.lastNewCandleDate || '-'}`);
    }
  } catch {}

  console.log(`  PID:     ${pidFile}`);
  console.log(`  STDOUT:  ${outFile}`);
  console.log(`  STDERR:  ${errFile}`);
}

async function cmdLogs() {
  const out = resolve(projectRoot, 'data', 'fly.out');
  const err = resolve(projectRoot, 'data', 'fly.err');
  const log = process.env.FLY_LOG_FILE
    ? resolve(projectRoot, process.env.FLY_LOG_FILE.replace(/^\.\//, ''))
    : resolve(projectRoot, 'data', 'fly.log');

  console.log('=== STDOUT (tail -f) ===');
  console.log(`  文件: ${out}`);
  console.log('=== 学习日志 (tail -f) ===');
  console.log(`  文件: ${log}`);

  // 用 spawn tail -f
  const tail = spawn('tail', ['-f', '-n', '50', out, log], { stdio: 'inherit' });
  process.on('SIGINT', () => { tail.kill('SIGTERM'); process.exit(0); });
}

// ============ main ============

const cmd = process.argv[2] || 'help';
(async () => {
  try {
    switch (cmd) {
      case 'start':  await cmdStart(); break;
      case 'stop':   await cmdStop();  break;
      case 'status': await cmdStatus(); break;
      case 'logs':   await cmdLogs(); break;
      default:
        console.log('用法: fly-daemon <start|stop|status|logs>');
        process.exit(1);
    }
  } catch (e: any) {
    console.error('错误:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();