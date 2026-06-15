import { rateLimit, rateLimitHeaders, tooManyRequests } from '../_ratelimit.js';

function getClientIP(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '0.0.0.0';
}

export async function onRequestGet(context) {
  const ip = getClientIP(context.request);
  const rl = await rateLimit(context.env, ip);
  if (rl?.limited) return tooManyRequests(rl);

  const url = new URL(context.request.url);
  const videoUrl = url.searchParams.get('url');
  if (!videoUrl) {
    return Response.json({ error: 'missing url param' }, { status: 400 });
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return Response.json({ error: 'invalid youtube url' }, { status: 400 });
  }

  try {
    const playerResp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20250101.00.00',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250101.00.00',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
    });

    if (!playerResp.ok) {
      return Response.json({ error: 'youtube api request failed' }, { status: 502 });
    }

    const data = await playerResp.json();

    if (data.playabilityStatus?.status === 'LOGIN_REQUIRED') {
      return Response.json({
        error: 'login_required',
        message: '此视频需要登录，请使用其他方式下载',
        videoId,
      }, { status: 403 });
    }

    if (data.playabilityStatus?.status === 'UNPLAYABLE') {
      return Response.json({
        error: 'unplayable',
        message: data.playabilityStatus.reason || '视频不可用',
      }, { status: 403 });
    }

    const details = data.videoDetails;
    const formats = [
      ...(data.streamingData?.formats || []),
      ...(data.streamingData?.adaptiveFormats || []),
    ];

    if (!formats.length) {
      return Response.json({
        error: 'no_formats',
        message: '未找到可下载格式，可能需要登录或视频受保护',
        videoId,
      }, { status: 404 });
    }

    const parsed = formats
      .filter(f => f.url || f.signatureCipher)
      .map(f => ({
        itag: f.itag,
        quality: f.qualityLabel || f.quality || '',
        mimeType: f.mimeType || '',
        width: f.width || 0,
        height: f.height || 0,
        fps: f.fps || 0,
        bitrate: f.bitrate || 0,
        contentLength: f.contentLength || '',
        hasAudio: !!f.audioBitrate || f.mimeType?.includes('audio'),
        hasVideo: !!f.width || f.mimeType?.includes('video'),
        url: f.url || '',
        isAudio: f.mimeType?.startsWith('audio/'),
        isVideo: f.mimeType?.startsWith('video/'),
      }));

    const videoFormats = parsed
      .filter(f => f.isVideo && f.url)
      .sort((a, b) => b.height - a.height);

    const audioFormats = parsed
      .filter(f => f.isAudio && f.url)
      .sort((a, b) => b.bitrate - a.bitrate);

    return Response.json({
      ok: true,
      title: details?.title || '',
      author: details?.author || '',
      duration: details?.lengthSeconds || '',
      thumbnail: details?.thumbnail?.thumbnails?.pop()?.url || '',
      videoId,
      videos: videoFormats.slice(0, 8),
      audios: audioFormats.slice(0, 3),
    }, { headers: rateLimitHeaders(rl) });

  } catch (err) {
    return Response.json({ error: 'internal', message: err.message }, { status: 500 });
  }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
    if (u.searchParams.has('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}
