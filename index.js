#!/usr/bin/env node
'use strict';

/**
 * nodejs-argo-lite
 * 极简版 Argo 隧道节点生成器：只保留 VLESS(WebSocket) + Cloudflare Argo 隧道。
 *
 * 流程：下载 Xray / cloudflared -> 启动 Xray(WS 入站) -> 启动 Argo 隧道
 *      -> 解析隧道域名 -> 生成 vless:// 节点与订阅 -> HTTP 输出
 */

const http = require('http');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const AdmZip = require('adm-zip');

/* ------------------------------- 环境变量 ------------------------------- */
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;              // HTTP 订阅服务端口
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';      // 节点 UUID
let ARGO_PORT = Number(process.env.ARGO_PORT || 8001);                        // Xray 本地监听端口
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';                            // 固定隧道域名，留空用临时隧道
const ARGO_AUTH = process.env.ARGO_AUTH || '';                                // 固定隧道 token 或 JSON 凭证
const CFIP = process.env.CFIP || 'www.visa.com.tw';                           // 优选 IP / 域名
const CFPORT = process.env.CFPORT || 443;                                     // 优选 IP 端口
const NAME = process.env.NAME || 'argo-vless';                                // 节点名称
const FILE_PATH = process.env.FILE_PATH || './tmp';                           // 运行目录
const SUB_PATH = process.env.SUB_PATH || 'sub';                               // 订阅路径
const XRAY_URL = process.env.XRAY_URL || '';                                  // 自定义 Xray 下载地址
const CFD_URL = process.env.CF_URL || '';                                     // 自定义 cloudflared 下载地址
const DISGUISE = !['false', 'disable', 'no', '0'].includes(                   // 是否启用伪装页
  String(process.env.DISGUISE || 'true').toLowerCase()
);
const DISGUISE_FILE = process.env.DISGUISE_FILE || path.join(__dirname, 'disguise.html'); // 自定义伪装页
// VPS-DOG 探针（可选，填写 NEZHA_SERVER + NEZHA_KEY 才启用）
const NEZHA_SERVER = (process.env.NEZHA_SERVER || '').replace(/\/+$/, '');      // 面板地址，如 https://vps-dog.xxx.workers.dev
const NEZHA_KEY = process.env.NEZHA_KEY || '';                                 // 面板签发的 Agent 令牌
const NEZHA_NAME = process.env.NEZHA_NAME || process.env.NAME || '';           // 节点显示名，留空用主机名
const NEZHA_REGION = process.env.NEZHA_REGION || '';                           // 地区标签，如 HK
const NEZHA_INTERVAL = Number(process.env.NEZHA_INTERVAL || 30);               // 上报间隔秒
const NEZHA_TLS_SKIP = ['true', 'yes', '1', 'on'].includes(                    // 面板证书自签名时开启
  String(process.env.NEZHA_TLS_SKIP_VERIFY || process.env.NEZHA_TLS_SKIP || 'false').toLowerCase()
);
const NEZHA_BIN = process.env.NEZHA_BIN || '';                                 // 自定义探针二进制路径
// 自动保活（自建心跳，不依赖第三方服务）
const AUTO_ACCESS = ['true', 'yes', '1', 'on'].includes(                       // 是否开启保活
  String(process.env.AUTO_ACCESS || 'false').toLowerCase()
);
const PROJECT_URL = (process.env.PROJECT_URL || '').replace(/\/+$/, '');       // 需要保活的项目地址
const KEEPALIVE_INTERVAL = Math.max(                                  // 保活间隔分钟，最少 1 分钟
  1,
  Number(process.env.KEEPALIVE_INTERVAL || 5) || 5
);
// 默认静默：平台上不再输出任何启动信息、节点链接与访问日志，避免被人一眼看出。
// 需要排障时设 SHOW_LOG=true 即可恢复完整输出。
const SHOW_LOG = !['false', 'disable', 'no', '0'].includes(
  String(process.env.SHOW_LOG || 'false').toLowerCase()
);

const WS_PATH = '/vless-argo';  // VLESS WebSocket 路径，与订阅节点保持一致
const ED = 2048;                // early data

let WS_PORT = 0;                // Xray 内部 WS 入站端口（由程序自动选择）

/* ------------------------------- 基础工具 ------------------------------- */
const log = (...args) => {
  if (SHOW_LOG) console.log(...args);
};
const errLog = (...args) => {
  if (SHOW_LOG) console.error(...args);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 静默模式下连 Node 自身的告警（DeprecationWarning）、未捕获堆栈一起吞掉，
// 否则平台上仍会零星出现带项目路径的英文报错，一眼就能看出跑的是什么。
if (!SHOW_LOG) {
  process.noDeprecation = true;
  const swallow = () => true;
  process.stdout.write = swallow;
  process.stderr.write = swallow;
}

function isValidPort(port) {
  const num = parseInt(port, 10);
  return !Number.isNaN(num) && num > 0 && num <= 65535;
}

// 检测端口是否可监听（被占用或系统保留都会返回 false）
function canListen(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

// 从 start 开始向后寻找一个可用端口
async function findFreePort(start) {
  for (let port = start; port < start + 1000 && port <= 65535; port++) {
    if (await canListen(port)) return port;
  }
  return 0;
}

// 等待端口进入监听状态
async function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (connected) return true;
    await sleep(500);
  }
  return false;
}

const workDir = path.resolve(FILE_PATH);
fs.mkdirSync(workDir, { recursive: true });

const configPath = path.join(workDir, 'config.json');
const xrayLogPath = path.join(workDir, 'xray.log');
const argoLogPath = path.join(workDir, 'cloudflared.log');
const subFilePath = path.join(workDir, 'sub.txt');
const tunnelJsonPath = path.join(workDir, 'tunnel.json');
const tunnelYmlPath = path.join(workDir, 'tunnel.yml');

const CLEAN_DELAY = Math.max(0, Number(process.env.CLEAN_DELAY || 90)) * 1000; // 自删文件延时（秒），0 关闭

let subContent = '';    // base64 订阅内容
let nodeLink = '';      // 生成的 vless 节点
let argoDomain = '';    // 当前隧道域名
let probeConfigPath = ''; // 探针配置文件路径
const logStreams = new Map();  // 日志文件路径 -> 写入流，自删前需关闭
const cleanTargets = new Set(); // 启动成功后待删除的文件

/* ------------------------------ 平台与架构 ------------------------------ */
function platformInfo() {
  const isArm = os.arch() === 'arm64' || os.arch() === 'aarch64';
  const isArm32 = os.arch() === 'arm';

  if (process.platform === 'win32') {
    return {
      xrayZip: isArm ? 'Xray-windows-arm64-v8a.zip' : 'Xray-windows-64.zip',
      xrayBin: 'xray.exe',
      cfdAsset: isArm ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe',
      cfdBin: 'cloudflared.exe',
      probeBin: 'vps-dog.exe',
      probeAsset: 'vps-dog-windows-amd64.exe'
    };
  }

  return {
    xrayZip: isArm ? 'Xray-linux-arm64-v8a.zip' : isArm32 ? 'Xray-linux-arm32-v7a.zip' : 'Xray-linux-64.zip',
    xrayBin: 'xray',
    cfdAsset: isArm ? 'cloudflared-linux-arm64' : isArm32 ? 'cloudflared-linux-arm' : 'cloudflared-linux-amd64',
    cfdBin: 'cloudflared',
    probeBin: 'vps-dog',
    probeAsset: isArm ? 'vps-dog-linux-arm64' : isArm32 ? 'vps-dog-linux-armv7' : 'vps-dog-linux-amd64'
  };
}

/* -------------------------------- 下载器 -------------------------------- */
async function download(url, dest, retries = 3) {
  const tmp = `${dest}.download`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 180000,
        maxRedirects: 5,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmp);
        res.data.pipe(writer);
        res.data.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', () => writer.close(() => {
          fs.renameSync(tmp, dest);
          resolve();
        }));
      });

      log(`下载成功: ${path.basename(dest)}`);
      return dest;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      log(`下载失败(${attempt}/${retries}): ${url} -> ${err.message}`);
      if (attempt === retries) throw err;
      await sleep(2000);
    }
  }
  return dest;
}

async function ensureXray(info) {
  const binPath = path.join(workDir, info.xrayBin);
  if (fs.existsSync(binPath)) {
    cleanTargets.add(binPath);
    return binPath;
  }

  const zipPath = path.join(workDir, 'xray.zip');
  const url = XRAY_URL || `https://github.com/XTLS/Xray-core/releases/latest/download/${info.xrayZip}`;

  log(`下载 Xray: ${url}`);
  await download(url, zipPath);
  // 只解出可执行文件：压缩包里的 geoip/geosite/许可文件在本项目配置中用不到，
  // 全部解压会留下一堆 90 秒自删覆盖不到的痕迹。
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry(info.xrayBin)
    || zip.getEntries().find((e) => path.basename(e.entryName) === info.xrayBin);
  if (entry) {
    zip.extractEntryTo(entry, workDir, false, true);
  } else {
    // 压缩包结构变化时退回全量解压，保证仍能启动
    zip.extractAllTo(workDir, true);
  }
  fs.rmSync(zipPath, { force: true });

  if (!fs.existsSync(binPath)) throw new Error('Xray 解压后未找到可执行文件');
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  cleanTargets.add(binPath);
  return binPath;
}

async function ensureCloudflared(info) {
  const binPath = path.join(workDir, info.cfdBin);
  if (fs.existsSync(binPath)) {
    cleanTargets.add(binPath);
    return binPath;
  }

  const url = CFD_URL || `https://github.com/cloudflare/cloudflared/releases/latest/download/${info.cfdAsset}`;

  log(`下载 cloudflared: ${url}`);
  await download(url, binPath);

  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  cleanTargets.add(binPath);
  return binPath;
}

/* ------------------------------ 进程管理 -------------------------------- */
const children = new Set();

function startProcess(binPath, args, logFile) {
  fs.writeFileSync(logFile, '');
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  logStreams.set(logFile, out);
  const child = spawn(binPath, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });

  children.add(child);

  const onData = (buf) => {
    // 自删后日志流已关闭，继续写会抛 ERR_STREAM_WRITE_AFTER_END
    if (!out.writableEnded) out.write(buf);
    if (SHOW_LOG) process.stdout.write(buf);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code) => {
    children.delete(child);
    log(`${path.basename(binPath)} 已退出，code=${code}`);
  });
  child.on('error', (err) => {
    children.delete(child);
    errLog(`${path.basename(binPath)} 启动失败: ${err.message}`);
  });

  // 跟踪这次启动产生的文件，供 90 秒自删使用
  cleanTargets.add(logFile);

  return child;
}

function shutdown() {
  for (const child of children) stopChild(child);
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (err) {
    // 忽略退出阶段的清理错误
  }
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

/* ------------------------------ 文件自删 --------------------------------- */
// 启动成功后延时删除本次运行产生的落地文件（配置、隧道凭证、探针令牌、日志、
// 下载的二进制）。进程已在内存中运行，删掉这些文件不影响节点工作。
// 用显式清单而不是遍历目录，避免 FILE_PATH 指向共享目录时误删无关文件。
// sub.txt 始终保留，供订阅接口在内存内容不可用时兜底。
function cleanFiles(delayMs = CLEAN_DELAY) {
  if (delayMs <= 0) {
    log('CLEAN_DELAY=0，跳过文件自删');
    return;
  }

  const timer = setTimeout(() => {
    // 先关闭日志写入流，否则 Windows 上文件被占用会删不掉
    for (const [file, stream] of logStreams) {
      try { stream.end(); } catch (err) { /* 流可能已关闭 */ }
      logStreams.delete(file);
    }

    let removed = 0;
    for (const file of cleanTargets) {
      if (file === subFilePath) continue;
      try {
        fs.rmSync(file, { force: true });
        removed++;
      } catch (err) {
        // Windows 上运行中的二进制被占用会失败，属于正常情况
      }
    }
    cleanTargets.clear();

    log(`已清理 ${removed} 个运行文件，服务继续运行`);
  }, delayMs);

  if (timer.unref) timer.unref();
  log(`将在 ${Math.round(delayMs / 1000)} 秒后自动清理运行文件`);
}

/* ------------------------------ Xray 配置 ------------------------------- */
function writeXrayConfig() {
  const wsInbound = {
    tag: 'vless-ws-in',
    listen: '127.0.0.1',
    port: WS_PORT,
    protocol: 'vless',
    settings: {
      clients: [{ id: UUID, level: 0 }],
      decryption: 'none'
    },
    streamSettings: {
      network: 'ws',
      security: 'none',
      wsSettings: { path: WS_PATH }
    }
  };

  // 公开入口：VLESS 走 WS 路径，其余 HTTP 请求回落到伪装页
  const tcpInbound = {
    tag: 'vless-tcp-in',
    listen: '127.0.0.1',
    port: ARGO_PORT,
    protocol: 'vless',
    settings: {
      clients: [{ id: UUID }],
      decryption: 'none',
      fallbacks: DISGUISE
        ? [{ path: WS_PATH, dest: WS_PORT, xver: 0 }, { dest: PORT, xver: 0 }]
        : [{ path: WS_PATH, dest: WS_PORT, xver: 0 }]
    },
    streamSettings: { network: 'tcp', security: 'none' }
  };

  const config = {
    // access 必须显式关掉：不写这一项时 Xray 会把每次请求
    // （客户端 IP + 目标域名）打到 stdout，平台上相当于公开浏览记录。
    // stdout/stderr 仍会被 startProcess 写入 xray.log，SHOW_LOG 打开时可排障。
    log: { access: 'none', error: 'none', loglevel: 'none' },
    inbounds: [tcpInbound, wsInbound],
    dns: { servers: ['https+local://8.8.8.8/dns-query'] },
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' }
    ]
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  cleanTargets.add(configPath);
  log(`Xray 配置已生成: ${configPath}`);
}

// 端口不可用时，从 8001 起向后寻找一个可用端口
async function ensureArgoPort() {
  if (isValidPort(ARGO_PORT) && await canListen(ARGO_PORT)) return true;

  const original = ARGO_PORT;
  for (let port = 8001; port < 9000; port++) {
    if (await canListen(port)) {
      ARGO_PORT = port;
      log(`端口 ${original} 不可用，已自动切换到 ${port}`);
      return true;
    }
  }
  return false;
}

// 启动 Xray，并在端口未监听成功时自动换端口重试
async function startXray(xrayBin) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    WS_PORT = await findFreePort(18001);
    if (!WS_PORT) {
      log('找不到可用的内部 WS 端口');
      return false;
    }

    writeXrayConfig();
    const child = startProcess(xrayBin, ['-c', configPath], xrayLogPath);

    if (await waitForPort(ARGO_PORT)) return true;

    log(`Xray 未能监听端口 ${ARGO_PORT}，尝试更换端口（第 ${attempt} 次）`);
    try { child.kill(); } catch (err) { /* 进程可能已退出 */ }
    await sleep(1000);

    if (!await ensureArgoPort()) break;
  }
  return false;
}

/* ------------------------------ 自动保活 -------------------------------- */
// 进程内自建心跳：定时访问 PROJECT_URL，避免免费 PaaS 因空闲回收实例。
// 不把域名交给任何第三方服务。
let keepaliveTimer = null;
let keepaliveFailures = 0;

async function keepaliveTick() {
  try {
    const res = await axios.get(PROJECT_URL, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: null
    });
    keepaliveFailures = 0;
    log(`保活成功: ${PROJECT_URL} -> HTTP ${res.status}`);
  } catch (err) {
    keepaliveFailures++;
    // 连续失败才提示，避免偶发抖动刷屏
    if (keepaliveFailures >= 3) {
      errLog(`保活失败 ${keepaliveFailures} 次: ${err.message}`);
    }
  }
}

function startKeepalive() {
  if (!AUTO_ACCESS) {
    log('AUTO_ACCESS 未开启，跳过保活');
    return false;
  }
  if (!PROJECT_URL) {
    errLog('AUTO_ACCESS 已开启但未填写 PROJECT_URL，跳过保活');
    return false;
  }
  if (!/^https?:\/\//i.test(PROJECT_URL)) {
    errLog(`PROJECT_URL 必须以 http:// 或 https:// 开头: ${PROJECT_URL}`);
    return false;
  }

  const periodMs = KEEPALIVE_INTERVAL * 60 * 1000;
  log(`保活已开启: 每 ${KEEPALIVE_INTERVAL} 分钟访问 ${PROJECT_URL}`);

  // 启动时先访问一次，既能立刻确认 URL 可达，也能尽快唤醒休眠实例
  keepaliveTick();
  keepaliveTimer = setInterval(keepaliveTick, periodMs);
  if (keepaliveTimer.unref) keepaliveTimer.unref();
  return true;
}

/* ------------------------------ Argo 隧道 ------------------------------- */
/* ------------------------------ VPS-DOG 探针 ---------------------------- */
// 下载 vps-dog agent（VPS-DOG 面板的探针）。优先使用本地 agent/ 源码编译的
// 二进制，其次官方 GitHub Release，最后回退到通用探针地址。
async function ensureProbe(info) {
  const binPath = path.join(workDir, info.probeBin);
  if (fs.existsSync(binPath)) return binPath;

  // 仓库内自带各平台二进制，避免依赖 GitHub 可达性
  const local = path.resolve(__dirname, 'bin', info.probeAsset);
  if (NEZHA_BIN && fs.existsSync(NEZHA_BIN)) {
    fs.copyFileSync(NEZHA_BIN, binPath);
  } else if (fs.existsSync(local)) {
    fs.copyFileSync(local, binPath);
  } else {
    const url = `https://github.com/heshang2011/vps-dog/releases/latest/download/${info.probeAsset}`;
    log(`下载 VPS-DOG 探针: ${url}`);
    await download(url, binPath);
  }

  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  return binPath;
}

function writeProbeConfig() {
  probeConfigPath = path.join(workDir, 'agent.yaml');

  const lines = [
    '# VPS-DOG agent configuration (generated by nodejs-argo-lite)',
    `server: "${NEZHA_SERVER}"`,
    `token: "${NEZHA_KEY}"`
  ];
  if (NEZHA_NAME) lines.push(`name: "${NEZHA_NAME}"`);
  if (NEZHA_REGION) lines.push(`region: "${NEZHA_REGION}"`);
  // 与服务端契约一致，上报间隔限制在 10..3600 秒
  const interval = Number.isFinite(NEZHA_INTERVAL) && NEZHA_INTERVAL > 0
    ? Math.min(Math.max(Math.floor(NEZHA_INTERVAL), 10), 3600)
    : 30;
  lines.push(`interval: ${interval}`);
  lines.push(`tls_skip_verify: ${NEZHA_TLS_SKIP}`);
  lines.push('');

  fs.writeFileSync(probeConfigPath, lines.join('\n'), { mode: 0o600 });
  cleanTargets.add(probeConfigPath);
  log(`探针配置已生成: ${probeConfigPath}`);
}

// 启动探针；失败只记录日志，不影响节点功能
async function startProbe(info) {
  if (!NEZHA_SERVER || !NEZHA_KEY) {
    log('NEZHA_SERVER / NEZHA_KEY 为空，跳过探针');
    return false;
  }

  try {
    writeProbeConfig();
    const binPath = await ensureProbe(info);
    cleanTargets.add(binPath);
    startProcess(binPath, ['-c', probeConfigPath], path.join(workDir, 'vps-dog.log'));
    await sleep(1500);
    return true;
  } catch (err) {
    errLog(`探针启动失败: ${err.message}`);
    return false;
  }
}

// 固定隧道：token 或 JSON 凭证；临时隧道：返回 null
function prepareFixedTunnel() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) return null;

  if (ARGO_AUTH.includes('TunnelSecret')) {
    let tunnelId = '';
    try {
      tunnelId = JSON.parse(ARGO_AUTH).TunnelID || '';
    } catch (err) {
      throw new Error('ARGO_AUTH JSON 格式错误');
    }
    if (!tunnelId) throw new Error('ARGO_AUTH 中缺少 TunnelID');

    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);
    cleanTargets.add(tunnelJsonPath);
    fs.writeFileSync(tunnelYmlPath, [
      `tunnel: ${tunnelId}`,
      `credentials-file: ${tunnelJsonPath}`,
      'protocol: http2',
      '',
      'ingress:',
      `  - hostname: ${ARGO_DOMAIN}`,
      `    service: http://127.0.0.1:${ARGO_PORT}`,
      '    originRequest:',
      '      noTLSVerify: true',
      '  - service: http_status:404',
      ''
    ].join('\n'));

    return {
      mode: 'json',
      // 固定隧道不需要从日志里解析域名，压到 warn 只保留真正的异常
      args: ['tunnel', '--no-autoupdate', '--edge-ip-version', 'auto', '--loglevel', 'warn', '--config', tunnelYmlPath, 'run']
    };
  }

  return {
    mode: 'token',
    args: ['tunnel', '--no-autoupdate', '--edge-ip-version', 'auto', '--protocol', 'http2', '--loglevel', 'warn', 'run', '--token', ARGO_AUTH]
  };
}

function quickTunnelArgs() {
  return [
    'tunnel',
    '--no-autoupdate',
    '--edge-ip-version', 'auto',
    '--protocol', 'http2',
    // 临时隧道域名只能从 info 日志里解析，这一项不能降级；
    // 输出只写本地日志文件，SHOW_LOG=false 时不会透传到平台日志。
    '--loglevel', 'info',
    '--url', `http://127.0.0.1:${ARGO_PORT}`
  ];
}

// 从 cloudflared 日志中解析临时隧道域名
async function waitForQuickTunnelDomain(child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return '';

    try {
      const content = fs.readFileSync(argoLogPath, 'utf8');
      // 排除 https://api.trycloudflare.com（错误信息里也会出现该地址）
      const match = content.match(/https:\/\/(?!api\.)([a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i);
      if (match) return match[1];
    } catch (err) {
      // 日志文件可能还没创建
    }
    await sleep(1000);
  }
  return '';
}

async function startArgo(cfdBin) {
  const fixed = prepareFixedTunnel();

  if (fixed) {
    log(`使用固定隧道: ${ARGO_DOMAIN}`);
    const child = startProcess(cfdBin, fixed.args, argoLogPath);
    await sleep(3000);
    if (child.exitCode !== null) throw new Error('固定隧道启动失败，请检查 ARGO_AUTH 是否正确');
    return ARGO_DOMAIN;
  }

  log('未配置 ARGO_DOMAIN / ARGO_AUTH，使用临时隧道');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const child = startProcess(cfdBin, quickTunnelArgs(), argoLogPath);
    const domain = await waitForQuickTunnelDomain(child);
    if (domain) return domain;

    log(`第 ${attempt} 次获取临时隧道域名失败，重试中...`);
    stopChild(child);   // 只重启 cloudflared，保持 Xray 运行
    await sleep(3000);
  }

  return '';
}

/* ------------------------------ 节点与订阅 ------------------------------ */
function buildNode(domain) {
  const params = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: domain,
    fp: 'firefox',
    type: 'ws',
    host: domain,
    path: `${WS_PATH}?ed=${ED}`
  });

  return `vless://${UUID}@${CFIP}:${CFPORT}?${params.toString()}#${encodeURIComponent(NAME)}`;
}

function publishNodes(domain) {
  argoDomain = domain;
  nodeLink = buildNode(domain);

  const subTxt = `${nodeLink}\n`;
  subContent = Buffer.from(subTxt, 'utf8').toString('base64');
  fs.writeFileSync(subFilePath, subContent);

  log('---------------- 节点信息 ----------------');
  log(nodeLink);
  log('------------------------------------------');
  log(`订阅路径: /${SUB_PATH}`);
}

/* ------------------------------- HTTP 服务 ------------------------------ */
function loadDisguisePage() {
  try {
    return fs.readFileSync(DISGUISE_FILE, 'utf8');
  } catch (err) {
    log(`伪装页读取失败(${DISGUISE_FILE})，使用内置页面: ${err.message}`);
    return '';
  }
}

let disguisePage = '';

// 伪装页文件缺失或读取失败时的兜底页面：始终是一个普通站点，
// 绝不回落到会暴露节点信息的内部页面。
const FALLBACK_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome</title>
</head>
<body>
<h1>Welcome</h1>
<p>This site is up and running.</p>
</body>
</html>`;

function renderHomePage() {
  const status = nodeLink ? '运行中' : '节点生成中，请稍候刷新';
  const node = nodeLink || '';
  const subUrl = `/${SUB_PATH}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>nodejs-argo-lite</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: radial-gradient(circle at 20% 20%, #1f3b73, #0b1220 60%); color: #e8eefc; }
  main { width: min(680px, 92vw); padding: 32px; border-radius: 18px;
         background: rgba(15, 23, 42, 0.72); border: 1px solid rgba(120, 160, 255, 0.25);
         box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: 0.5px; }
  .sub { color: #93a6c8; font-size: 13px; margin-bottom: 22px; }
  .row { margin-bottom: 16px; }
  .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #7f96bd; margin-bottom: 6px; }
  code { display: block; padding: 12px 14px; border-radius: 10px; word-break: break-all;
         background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(120, 160, 255, 0.18);
         font-family: Consolas, "SFMono-Regular", monospace; font-size: 13px; }
  a { color: #7fb0ff; text-decoration: none; }
  .status { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px;
            background: rgba(90, 220, 160, 0.15); color: #6ee7b7; border: 1px solid rgba(110, 231, 183, 0.35); }
</style>
</head>
<body>
<main>
  <h1>nodejs-argo-lite</h1>
  <div class="sub">VLESS + WebSocket + Cloudflare Argo 隧道</div>
  <div class="row"><span class="status">${status}</span></div>
  <div class="row">
    <div class="label">隧道域名</div>
    <code>${argoDomain || '等待分配...'}</code>
  </div>
  <div class="row">
    <div class="label">节点</div>
    <code>${node || '生成中...'}</code>
  </div>
  <div class="row">
    <div class="label">订阅</div>
    <code><a href="${subUrl}">${subUrl}</a></code>
  </div>
</main>
</body>
</html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];

    if (urlPath === `/${SUB_PATH}`) {
      const body = subContent || (fs.existsSync(subFilePath) ? fs.readFileSync(subFilePath, 'utf8') : '');
      if (!body) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('订阅尚未生成，请稍后重试。');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }

    // 默认入口：所有非订阅请求都返回伪装页，不暴露节点信息。
    // 启动早期或伪装页文件缺失时用兜底页，绝不回落成节点信息页。
    if (DISGUISE) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(disguisePage || FALLBACK_PAGE);
      return;
    }

    if (urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHomePage());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.on('error', (err) => errLog(`HTTP 服务错误: ${err.message}`));
  server.listen(PORT, () => log(`HTTP 服务已启动，端口 ${PORT}`));
}

/* --------------------------------- 主流程 ------------------------------- */
async function main() {
  const info = platformInfo();

  if (DISGUISE) {
    disguisePage = loadDisguisePage();
    log(disguisePage ? '伪装页已加载' : '伪装页为空，已跳过');
  }

  if (!await ensureArgoPort()) {
    errLog('找不到可用端口，无法启动 Xray');
    return;
  }

  const [xrayBin, cfdBin] = await Promise.all([ensureXray(info), ensureCloudflared(info)]);

  if (!await startXray(xrayBin)) {
    errLog(`Xray 启动失败，请检查日志: ${xrayLogPath}`);
    return;
  }

  // 探针独立运行，失败不影响节点
  await startProbe(info);

  startKeepalive();

  const domain = await startArgo(cfdBin);
  if (!domain) {
    errLog('未能获取 Argo 隧道域名，节点生成失败');
    return;
  }

  publishNodes(domain);
  cleanFiles();
}

startServer();
main().catch((err) => errLog(`启动失败: ${err.message}`));
