// 流式媒体代理：绕过 Twitter CDN 防盗链，强制下载
// 仅允许 twimg 资源域，防止被当作开放代理滥用

const ALLOWED_HOSTS = [
  'video.twimg.com',
  'pbs.twimg.com',
  'ton.twimg.com',
];

function getClientIP(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '0.0.0.0';
}

function getExt(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const last = u.pathname.split('/').pop() || '';
    const m = last.match(/\.([a-zA-Z0-9]{2,4})$/);
    if (m) return m[1].toLowerCase();
    // pbs.twimg.com 的图片可能用 ?format=jpg
    const fmt = u.searchParams.get('format');
    if (fmt) return fmt.toLowerCase();
    return 'mp4';
  } catch {
    return 'bin';
  }
}

export async function onRequestGet(context) {
  const ip = getClientIP(context.request);
  const reqUrl = new URL(context.request.url);
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    return new Response('missing url param', { status: 400 });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('invalid url', { status: 400 });
  }

  // 白名单校验（含子域）
  const host = targetUrl.hostname;
  const allowed = ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  if (!allowed) {
    return new Response('host not allowed', { status: 403 });
  }

  // 文件名：优先用前端传入，否则按扩展名兜底
  const ext = getExt(target);
  const rawName = reqUrl.searchParams.get('filename') || ('media.' + ext);
  const safeName = rawName.replace(/[^\w.\-]/g, '_');

  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        // 伪造来源，绕过 twimg 防盗链
        'Referer': 'https://x.com/',
        'Origin': 'https://x.com',
      },
    });

    if (!resp.ok) {
      return new Response('upstream error: ' + resp.status, { status: 502 });
    }

    const headers = new Headers(resp.headers);
    // 强制浏览器下载（而非内联播放）
    headers.set(
      'Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
    );
    headers.set('Access-Control-Allow-Origin', '*');
    headers.delete('X-Frame-Options');
    headers.delete('Content-Encoding'); // 已解压，避免双解压

    // 流式转发上游响应体
    return new Response(resp.body, {
      status: 200,
      headers,
    });
  } catch (e) {
    return new Response('proxy failed: ' + e.message, { status: 502 });
  }
}
