// scripts/test-remote-urls.mjs —— 用**真实**的 token 与工作区跑一遍 /q网址 的内容
//
//   node scripts/test-remote-urls.mjs            # 用真实 ingredients（token 文件 + quest API）
//   node scripts/test-remote-urls.mjs --offline  # 只跑纯函数用例，不碰本机文件/服务
//
// 这样"QQ 里发出来那句话对不对"不再需要真发一条 QQ：这里打印的就是 /q网址 会发的内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRemoteUrls, consoleUrl, dshUrls } from '../src/remote-urls.mjs';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ── 纯函数用例 ──────────────────────────────────────────────
const full = buildRemoteUrls({ vip: '192.168.188.1', questToken: 'TOK123', dshToken: 'DSHTOK', wsKey: 'C-Users-Solanine-Desktop-V8-code_kl', wsPath: 'C:/Users/Solanine/Desktop/V8/code_kl' });
check('① 控制台地址带 token 与 ws', full.console === 'http://192.168.188.1:3083/dashboard-v2?token=TOK123&ws=C-Users-Solanine-Desktop-V8-code_kl', full.console);
check('② DSH 同屏 3081 / 直通 3082 带 token', full.dshMirror === 'http://192.168.188.1:3081' && full.dshDirect === 'http://192.168.188.1:3082/?token=DSHTOK', `${full.dshMirror} | ${full.dshDirect}`);
check('③ 文本里两条都出现，且带序号好读', /① 控制台/.test(full.text) && /② DSH/.test(full.text) && full.text.includes('3083/dashboard-v2'), '');

const noTok = buildRemoteUrls({ vip: '192.168.188.1', dshToken: '', questToken: '', wsKey: '' });
check('④ 缺 quest 令牌时明说原因（不静默给个打不开的链接）', noTok.console === null && /读不到 quest 令牌/.test(noTok.text), '');
check('⑤ 直通中继异常时给可操作提示', /直通中继异常/.test(buildRemoteUrls({ vip: '1.2.3.4', questToken: 'x', relayConflict: '3082 被其它进程（pid=9）占用' }).text), '');
check('⑥ 没传 vip 时退回 127.0.0.1（不会拼出空主机）', consoleUrl({ questToken: 'x' }).startsWith('http://127.0.0.1:3083/'), '');

// ── 真实 ingredients（本机）─────────────────────────────────
if (!process.argv.includes('--offline')) {
  const tokenPath = path.join(os.homedir(), '.dsh', 'quests', '.token');
  let questToken = ''; try { questToken = fs.readFileSync(tokenPath, 'utf8').trim(); } catch {}
  check('⑦ 能读到 quest 令牌', !!questToken, questToken ? `${questToken.slice(0, 6)}…` : tokenPath + ' 不存在');

  // 星空 IP：与 bridge 的 pickRemoteHost 同规则（优先 192.168.188.*）
  const nets = os.networkInterfaces();
  let vip = '';
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      if (a.address.startsWith('192.168.188.')) vip = a.address;
      else if (!vip && /star|vpn/i.test(name)) vip = a.address;
    }
  }
  check('⑧ 找到星空组网 IP', !!vip, vip || '（接口名含 Star/VPN 或 192.168.188.*）');

  let wsKey = '', wsPath = '';
  try {
    const r = await fetch('http://127.0.0.1:3110/api/workspaces', { headers: questToken ? { 'x-quest-token': questToken } : {}, signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const pick = (j.workspaces || []).filter((w) => !w.junk)[0];
    if (pick) { wsKey = pick.wsKey; wsPath = pick.workspace || ''; }
  } catch (e) { /* quest 没跑也不算错，下面单独判 */ }
  check('⑨ 从 quest 取到最近活跃工作区（排序后的第一项）', !!wsKey, `${wsKey} ${wsPath ? '(' + wsPath + ')' : ''}`);

  let dshToken = '';
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.dsh', 'dsh-run.log'), 'utf8');
    const ms = [...t.matchAll(/dsh web: http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/g)];
    if (ms.length) dshToken = ms[ms.length - 1][1];
  } catch {}
  check('⑩ 从 dsh-run.log 取到 DSH 令牌', !!dshToken, dshToken ? `${dshToken.slice(0, 6)}…` : '（日志里没有 dsh web 行）');

  console.log('\n———— /q网址 会发出的内容（真实 ingredients）————');
  console.log(buildRemoteUrls({ vip, questToken, dshToken, wsKey, wsPath }).text);
  console.log('————————————————————————————————');
}

console.log(`\n[test-remote-urls] ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
