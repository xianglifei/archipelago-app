// 邀请落地页 Worker(2026-11-03 邀请函重做):qundao.app/i/<code> 由本脚本调 sea 免登录端点渲染;
// 其余路径全部走 static assets(index/download 页,见 wrangler.jsonc assets 配置)。
// 纯 JS 无构建(与 console/app.js 同纪律:语法错=整页空白,部署链已挂 node --check)。
// 视觉定稿:手机单列/桌面双栏等高+header,hero 图走 assets(定稿原档在内部设计归档,不入公开仓)。
// 注:不直绑 D1——本账号「新建 Worker 绑 D1」被 API 10181 拒(存量 worker 不受影响,平台侧数据不一致),
// 落地页数据改走 sea GET /post/invites/landing(方案 B),同在 CF 边缘,内网互通延迟可忽略。

const CODE_RE = /^\/i\/([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6})\/?$/

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const m = CODE_RE.exec(url.pathname)
    if (!m) return new Response('Not Found', { status: 404 })
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })

    const code = m[1]
    let invite = null
    let unreachable = false
    try {
      const res = await fetch(`https://sea.qundao.app/post/invites/landing?c=${encodeURIComponent(code)}`, {
        signal: AbortSignal.timeout(4000),
        headers: { 'user-agent': 'qundao-website-invite/1' },
      })
      if (res.ok) {
        const data = await res.json()
        const payload = data && data.data ? data.data : data
        if (payload && payload.found) invite = payload
      } else {
        // B6 修复:sea 非 2xx(5xx/网关错误等)此前会静默落到「已过期」——对用户说谎。
        // sea 对无效码/过期码的预期应答是 200+found:false(见 cloud/src/post.ts /post/invites/landing),
        // 所以任何非 ok 都不是预期路径,一律按「服务暂不可用」诚实态。
        unreachable = true
      }
    } catch {
      unreachable = true // 网络异常/超时/响应体非合法 JSON:诚实提示,不冒充「已过期」
    }

    const html = invite ? renderValid(invite) : unreachable ? renderUnreachable() : renderExpired()
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store', // 码 7 天过期且可作废,落地页不做任何缓存
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
      },
    })
  },
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function untilLabel(expiresAt) {
  const d = new Date(Number(expiresAt))
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

function shell({ state, hostLine, heroTitle, bodyHtml }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>群岛邀请函</title>
<style>
  * { box-sizing:border-box; margin:0; }
  body { background:#F7F5EE; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  .page { max-width:430px; margin:0 auto; background:#F7F5EE; min-height:100vh;
    box-shadow:0 0 40px rgba(20,60,55,.18); overflow:hidden; display:flex; flex-direction:column; }
  .hero { position:relative; aspect-ratio:3/4; }
  .hero img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .expired .hero { filter:grayscale(.75) brightness(1.04); }
  .hero::after { content:""; position:absolute; left:0; right:0; bottom:0; height:110px;
    background:linear-gradient(180deg, rgba(247,245,238,0) 0%, rgba(247,245,238,.55) 55%, #F7F5EE 100%); }
  .hero-title { position:absolute; top:9%; width:100%; text-align:center;
    font-family:"Songti SC","STSong",serif; font-weight:900; font-size:40px; color:#fff;
    letter-spacing:9px; text-indent:9px; text-shadow:0 3px 14px rgba(16,62,62,.45); }
  .hero-title i { display:inline-block; width:26px; height:2.5px; background:rgba(255,255,255,.92);
    border-radius:2px; vertical-align:9px; margin:0 13px; box-shadow:0 1px 5px rgba(16,62,62,.4); }
  .sheet-wrap { position:relative; margin:-46px 14px 0; }
  .sheet { background:#FCFBF6; border-radius:22px; box-shadow:0 14px 34px rgba(13,70,70,.22);
    padding:30px 24px 26px; text-align:center; }
  .host { font-size:27px; font-weight:600; color:#1E8B85; letter-spacing:2px; }
  .host i { font-style:normal; color:#B9C9C2; margin:0 8px; font-weight:400; }
  .invite-line { margin-top:10px; font-size:19px; color:#3A5450; letter-spacing:2px; }
  .code-cells { margin-top:24px; display:flex; gap:8px; justify-content:center; }
  .cell { width:46px; height:58px; background:#fff; border:1.5px solid #CBE6F5; border-radius:9px;
    box-shadow:0 4px 9px rgba(30,139,133,.10); display:flex; align-items:center; justify-content:center;
    font-size:30px; font-weight:700; color:#1E8B85; font-variant-numeric:tabular-nums; }
  .meta { margin-top:12px; font-size:12px; color:#7A9B93; letter-spacing:1px; }
  .btn-copy { margin-top:22px; width:100%; min-height:50px; border:none; border-radius:13px;
    background:#1E8B85; color:#fff; font-size:16px; font-weight:500; font-family:inherit;
    display:inline-flex; justify-content:center; align-items:center; cursor:pointer; }
  .btn-copy:active { background:#17706B; }
  .btn-copy.done { background:#5F8F87; }
  .btn-dl { margin-top:12px; width:100%; min-height:50px; border:1.5px solid #1E8B85; border-radius:13px;
    background:#fff; color:#1E8B85; font-size:16px; font-weight:500; font-family:inherit;
    display:inline-flex; justify-content:center; align-items:center; text-decoration:none; }
  .dl-hint { margin-top:8px; font-size:12px; color:#7A9B93; letter-spacing:1px; }
  .guide { margin-top:18px; background:#EDF5F1; border-radius:12px; padding:13px 14px;
    font-size:13px; line-height:1.8; color:#3A5450; text-align:left; }
  .guide b { color:#1E8B85; font-weight:600; }
  .expired-box { padding:26px 10px 6px; text-align:center; }
  .expired-box .t { font-family:"Songti SC","STSong",serif; font-weight:900; font-size:30px;
    color:#3A5450; letter-spacing:5px; }
  .expired-box .d { margin-top:12px; font-size:14px; color:#7A9B93; line-height:1.9; }
  .expired-box .go { margin-top:24px; display:inline-flex; min-height:48px; padding:0 26px;
    border:1.5px solid #1E8B85; border-radius:13px; color:#1E8B85; font-size:15px; font-weight:500;
    text-decoration:none; align-items:center; }
  .sea { margin-top:auto; background:linear-gradient(180deg,#54D6CB 0%,#48C9C4 100%);
    padding:12px 16px 16px; text-align:center; }
  .sea .brand { font-size:15px; font-weight:600; color:#fff; letter-spacing:4px;
    text-shadow:0 1px 6px rgba(10,60,60,.35); }
  .sea .site { margin-top:5px; font-size:12px; color:rgba(255,255,255,.85); letter-spacing:2px; }
  .topbar { display:none; position:relative; align-items:center; justify-content:center;
    padding:13px 30px; background:linear-gradient(180deg,#48C9C4 0%,#54D6CB 100%); }
  .topbar .brand { font-size:21px; font-weight:700; color:#fff; letter-spacing:10px; text-indent:10px;
    text-shadow:0 1px 6px rgba(10,60,60,.35); }
  .topbar .link { position:absolute; right:30px; top:50%; transform:translateY(-50%);
    font-size:12px; color:#fff; text-decoration:none; letter-spacing:1px;
    border:1.5px solid rgba(255,255,255,.85); border-radius:9px; padding:5px 14px; }
  .main { display:block; }
  @media (min-width:900px) {
    .page { max-width:920px; }
    .topbar { display:flex; }
    .main { display:flex; flex:1; align-items:center; padding:16px 26px; }
    .row { display:flex; gap:26px; align-items:stretch; width:100%; }
    .hero { flex:none; width:44%; aspect-ratio:auto; border-radius:24px; overflow:hidden;
      box-shadow:0 18px 40px rgba(13,70,70,.20); }
    .hero img { position:static; width:100%; height:100%; }
    .hero::after { display:none; }
    .hero-title { top:34px; }
    .sheet-wrap { margin:0; flex:1; display:flex; align-items:stretch; }
    .sheet { width:100%; display:flex; flex-direction:column; justify-content:center;
      box-shadow:0 14px 34px rgba(13,70,70,.10); }
    .sea { margin-top:0; }
  }
</style>
</head>
<body>
<div class="page${state === 'expired' ? ' expired' : ''}">
  <header class="topbar">
    <div class="brand">群 岛</div>
    <a class="link" href="https://qundao.app">了解群岛</a>
  </header>
  <div class="main">
  <div class="row">
  <div class="hero">
    <img src="/invite-hero.webp" alt="群岛插画">
    <div class="hero-title"><i></i>邀请函<i></i></div>
  </div>
  <div class="sheet-wrap">
    <div class="sheet">
${bodyHtml}
    </div>
  </div>
  </div>
  </div>
  <div class="sea">
    <div class="brand">群 岛</div>
    <div class="site">与各有所长的 AI 伙伴一起工作</div>
  </div>
</div>
${hostLine}
</body>
</html>`
}

function renderValid(invite) {
  const cells = String(invite.code)
    .split('')
    .map((c) => `<div class="cell">${esc(c)}</div>`)
    .join('')
  const body = `      <div class="host">${esc(invite.islandName)}<i>·</i>岛主 ${esc(invite.ownerName)}</div>
      <div class="invite-line">邀请你来群岛,成为好友</div>
      <div class="code-cells">${cells}</div>
      <div class="meta">邀请码 · ${esc(untilLabel(invite.expires_at))}前有效</div>
      <button class="btn-copy" type="button" data-code="${esc(invite.code)}">复制邀请码</button>
      <a class="btn-dl" href="https://qundao.app/download.html">下载群岛客户端(Mac / Windows)</a>
      <div class="dl-hint">macOS 13+ / Windows 10+ · 免费</div>
      <div class="guide">已装群岛?打开 <b>群岛 → 邮局 → 邀请函 → 导入邀请函</b>,输入 6 位邀请码,给岛主发一封申请信。</div>`
  const hostLine = `<script>
(function () {
  var btn = document.querySelector('.btn-copy');
  btn.addEventListener('click', function () {
    var code = btn.dataset.code;
    function done() {
      btn.classList.add('done'); btn.textContent = '已复制 ' + code;
      setTimeout(function () { btn.classList.remove('done'); btn.textContent = '复制邀请码'; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = code; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {} 
      document.body.removeChild(ta);
    }
  });
})();
</script>`
  return shell({ state: 'valid', hostLine, bodyHtml: body })
}

function renderUnreachable() {
  const body = `      <div class="expired-box">
        <div class="t">邀请页暂时打不开</div>
        <div class="d">网络开了一会儿小差<br>请稍后重新扫码打开</div>
        <a class="go" href="https://qundao.app">去官网看看群岛</a>
      </div>`
  return shell({ state: 'expired', hostLine: '', bodyHtml: body })
}

function renderExpired() {
  const body = `      <div class="expired-box">
        <div class="t">邀请函已过期</div>
        <div class="d">邀请码有效期 7 天<br>请向岛主索取一张新的邀请函</div>
        <a class="go" href="https://qundao.app">去官网看看群岛</a>
      </div>`
  return shell({ state: 'expired', hostLine: '', bodyHtml: body })
}
