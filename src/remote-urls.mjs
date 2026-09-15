// src/remote-urls.mjs —— 远程访问地址的拼装（纯函数，便于直接跑测试）
//
// 为什么要单独一个模块（2026-09-15）：bridge.js 是 8000+ 行的单文件，里面的命令没法从外面调用，
// 于是"网址拼得对不对"只能靠人肉发 QQ 试。抽成纯函数后，scripts/test-remote-urls.mjs 可以直接
// 用它 + 真实的 token/工作区跑一遍，输出与 QQ 里看到的完全一致。
//
// 两条链路（都在星空组网 IP 上，默认 192.168.188.1）：
//   · 控制台（quest）：3083 → dsh-direct-relay → 127.0.0.1:3110，路径 /dashboard-v2，带 ?token= 与 &ws=
//   · DSH：同屏 3081（镜像工位画面，密码不变）/ 直通 3082（独立完整界面，带 ?token=）

export const DEFAULT_WS_PATH = 'C:/Users/Solanine/Desktop/V8/code_kl';

/** 控制台地址（带令牌与工作区） */
export function consoleUrl({ host, questToken, wsKey }) {
  const h = host || '127.0.0.1';
  const base = `http://${h}:3083/dashboard-v2`;
  if (!questToken) return null;
  return `${base}?token=${questToken}${wsKey ? `&ws=${wsKey}` : ''}`;
}

/** DSH 地址（同屏 / 直通） */
export function dshUrls({ host, dshToken }) {
  const h = host || '127.0.0.1';
  return {
    mirror: `http://${h}:3081`,
    direct: dshToken ? `http://${h}:3082/?token=${dshToken}` : null,
  };
}

/**
 * 拼成 QQ 里发出去的那段文字。缺什么就说清缺什么（远端最怕"链接给了但打不开还看不出原因"）。
 * @param {{vip?:string, dshToken?:string, questToken?:string, wsKey?:string, wsPath?:string, relayConflict?:string}} o
 */
export function buildRemoteUrls({ vip, dshToken, questToken, wsKey, wsPath, relayConflict } = {}) {
  const host = vip || '127.0.0.1';
  const cUrl = consoleUrl({ host, questToken, wsKey });
  const d = dshUrls({ host, dshToken });
  const L = [`【远程网址】${host}`, ''];

  L.push('① 控制台（任务线画布 / 正在跑 / 全部节点明细）');
  if (cUrl) {
    L.push(`   ${cUrl}`);
    if (wsKey) L.push(`   工作区 ws=${wsKey}${wsPath ? `（${wsPath}）` : ''}——想换工作区就改 ws=，或在页面上用左上角下拉`);
  } else {
    L.push('   ⚠️ 读不到 quest 令牌（~/.dsh/quests/.token）——先确认 quest 在跑（node tools/when-idle.mjs）');
  }
  L.push('');

  L.push('② DSH');
  L.push(`   同屏（镜像工位画面，LAN 密码不变）：${d.mirror}`);
  if (d.direct) L.push(`   直通（独立完整界面，无常驻负载）：${d.direct}`);
  else if (relayConflict) L.push(`   ⚠️ 直通中继异常：${relayConflict}——先用同屏门，或到电脑上 taskkill /PID <该 pid> /T /F 后再问一次`);
  else L.push('   直通中继未响应（已尝试自动拉起，稍后再问一次）');

  return { text: L.join('\n'), console: cUrl, dshMirror: d.mirror, dshDirect: d.direct };
}
