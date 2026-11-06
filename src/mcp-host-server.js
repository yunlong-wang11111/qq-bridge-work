// SnowLuma 进程管理 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行），
// 给 agent 提供 SnowLuma 网关的状态查询与启停工具。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（HTTP get_login_info）
//   start_snowluma    —— 未运行时启动 launcher.bat 并等待网关就绪（最长 90s）
//   stop_snowluma     —— 停止 SnowLuma（按安装目录匹配进程）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const launcher = c.snowluma?.launcherPath ?? '';
  return {
    httpUrl,
    httpPort: new URL(httpUrl).port || '80',
    token: c.snowluma?.accessToken ?? '',
    launcher,
    homeDir: c.snowluma?.homeDir ?? (launcher ? path.dirname(launcher) : ''),
    // 进程控制默认关闭：只有 config.json 显式设置 snowluma.allowProcessControl=true 才允许启停
    allowProcessControl: c.snowluma?.allowProcessControl === true
  };
}

function getConsolePort() {
  try {
    const c = getConfig();
    return Number(c.consolePort) || 3100;
  } catch {
    return 3100;
  }
}

function readConsoleToken() {
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

// 进程控制只允许在 closed-agent（仅管理员私聊）模式下使用，防止 chat/reserved 的 agent 被群友诱导启停 SnowLuma。
async function bridgeModeAllowsProcessControl() {
  try {
    const token = readConsoleToken();
    const res = await fetch(`http://127.0.0.1:${getConsolePort()}/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.mode === 'closed-agent';
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

function findSnowLumaPids() {
  // 先按 OneBot HTTP 端口找监听进程，再用安装目录过滤命令行，
  // 避免误杀恰好占用同一端口的其他进程。
  const { httpPort, homeDir } = getHostConfig();
  const portNum = Number(httpPort);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return [];
  const pids = new Set();
  try {
    const byPort = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${portNum} } | Select-Object -ExpandProperty OwningProcess -Unique`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', byPort], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
    for (const s of out.split(/\s+/)) {
      const n = Number(s.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  } catch {}
  const home = String(homeDir || '').toLowerCase().replace(/\\/g, '/');
  const result = [];
  for (const pid of pids) {
    try {
      const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { timeout: 10000, windowsHide: true, encoding: 'utf8' }).trim();
      const cmdLower = String(cmd || '').toLowerCase().replace(/\\/g, '/');
      if (home && cmdLower.includes(home)) result.push(pid);
    } catch {
      // 拿不到命令行时宁可不杀，避免误伤
    }
  }
  return result;
}

const server = new McpServer({ name: 'snowluma-host', version: '0.1.0' });

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（HTTP 探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只有显式开启进程控制且当前为 closed-agent 时，才暴露本机路径/PID 这类敏感信息。
    const admin = hc.allowProcessControl && await bridgeModeAllowsProcessControl();
    const extra = admin ? { launcher: hc.launcher, homeDir: hc.homeDir, processPids: findSnowLumaPids() } : {};
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...info, ...extra }, null, 2) }]
    };
  }
);

if (getHostConfig().allowProcessControl) {
  server.tool(
    'start_snowluma',
    '启动 SnowLuma（launcher.bat，独立窗口）并等待 OneBot 网关就绪，最长 90 秒。已在运行时直接返回当前状态。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.launcher) {
        return { content: [{ type: 'text', text: '拒绝：未配置 snowluma.launcherPath。' }], isError: true };
      }
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const before = await gatewayInfo();
      if (before.reachable && before.online) {
        return { content: [{ type: 'text', text: JSON.stringify({ started: false, alreadyOnline: true, info: before }) }] };
      }
      let spawnError = null;
      const child = spawn('cmd.exe', ['/c', 'start', '', `"${hc.launcher}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => { spawnError = err; });
      child.unref();
      let info = null;
      for (let i = 0; i < 45; i += 1) {
        if (spawnError) {
          return { content: [{ type: 'text', text: `启动失败：${spawnError?.message ?? spawnError}` }], isError: true };
        }
        await sleep(2000);
        info = await gatewayInfo();
        if (info.reachable && info.online) {
          return { content: [{ type: 'text', text: JSON.stringify({ started: true, readyAfterMs: (i + 1) * 2000, info }) }] };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ started: false, timeout: true, lastInfo: info ?? before }) }] };
    }
  );

  server.tool(
    'stop_snowluma',
    '停止 SnowLuma 进程（按安装目录匹配 node 进程后 taskkill）。谨慎使用：会断开当前 QQ 连接。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const pids = findSnowLumaPids();
      if (pids.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ stopped: false, reason: 'no process found' }) }] };
      }
      const killed = [];
      for (const pid of pids) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
          killed.push(pid);
        } catch (error) {
          // 进程可能已退出
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ stopped: true, killed }) }] };
    }
  );
} // if (allowProcessControl) 到此为止——send_group_message 与进程控制无关,移到块外
  //（2026-09-24 修:此前工具被困在这个 if 里,allowProcessControl=false 时根本不注册,kl 手里一直没有它）

// ── send_group_message（2026-09-22）──────────────────────────────────────────
// 主动向登记过的 QQ 群发消息：**不占对话正文**（只占一次工具调用），适合阶段汇报/通知。
// 安全边界：群号必须在 config.json 的 groupWorkspaces 里登记过（防误发陌生群）。
// 分条：文本里**单独一行的 ---** 会拆成多条发送（与桥的转发纪律一致）。
server.tool(
  'send_group_message',
  '向指定 QQ 群发一条消息（主动汇报/通知用；比在对话里说一段省上下文）。群号必须是 config.json groupWorkspaces 里登记过的；文本中用单独一行的 --- 可分条发送。',
  {
    groupId: z.string().describe('目标 QQ 群号（必须是已登记的映射群）'),
    text: z.string().describe('消息内容；用单独一行的 --- 分段会拆成多条发送'),
  },
  async ({ groupId, text }) => {
    const cfg2 = getConfig();
    const allowed = Object.keys(cfg2.groupWorkspaces || {});
    const gid = String(groupId || '').trim();
    if (!allowed.includes(gid)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${gid || '(空)'} 未在 groupWorkspaces 登记。已登记的群：${allowed.join(', ') || '(无)'}` }], isError: true };
    }
    let token = String(cfg2.consoleToken || '').trim();
    if (!token) {
      try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
    }
    if (!token) return { content: [{ type: 'text', text: '拒绝：读不到桥的控制台令牌（config.consoleToken 或 state/console-token）' }], isError: true };

    const parts = String(text || '').split(/^[ \t]*---[ \t]*$/m).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return { content: [{ type: 'text', text: '拒绝：消息为空' }], isError: true };
    const sent = [];
    for (const p of parts) {
      try {
        const r = await fetch('http://127.0.0.1:3100/api/send/group', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': token },
          body: JSON.stringify({ groupId: gid, message: p }),
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) {
          return { content: [{ type: 'text', text: `发送失败（第 ${sent.length + 1} 段）：${j.error || r.status}` }], isError: true };
        }
        sent.push(p.slice(0, 30));
      } catch (e) {
        return { content: [{ type: 'text', text: `发送异常（第 ${sent.length + 1} 段）：${String(e?.message || e).slice(0, 120)}` }], isError: true };
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, groupId: gid, sentCount: sent.length }) }] };
  }
);

// ── send_file（2026-09-27）──────────────────────────────────────────────────
// AI 把本地文件发到 owner 私聊或登记群(SnowLuma upload_*_file)。安全:owner/白名单群+本地路径+100MB。
server.tool(
  'send_file',
  '把本地文件直接发到 QQ(owner 私聊或已登记的映射群)。适合:结果 csv/PDF/图、打包产物——比"在群里说路径"直接。',
  {
    target: z.enum(['private', 'group']).describe('private=发给 owner 私聊;group=发到登记群'),
    id: z.string().describe('QQ 号或群号(群必须在 groupWorkspaces 登记)'),
    path: z.string().describe('本地文件绝对路径(≤100MB)'),
  },
  async ({ target, id, path: filePath }) => {
    const cfg2 = getConfig();
    let token = String(cfg2.consoleToken || '').trim();
    if (!token) { try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {} }
    if (!token) return { content: [{ type: 'text', text: '拒绝：读不到桥控制台令牌' }], isError: true };
    try {
      const r = await fetch('http://127.0.0.1:3100/api/send/file', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token },
        body: JSON.stringify({ target, ...(target === 'group' ? { groupId: id } : { userId: id }), path: filePath }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) return { content: [{ type: 'text', text: `发送失败:${j.error || r.status}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, sent: `${target}:${id}`, name: j.name, bytes: j.bytes }) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `发送异常:${String(e?.message || e).slice(0, 120)}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
