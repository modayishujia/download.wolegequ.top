import { rateLimit, rateLimitHeaders, tooManyRequests } from '../_ratelimit.js';

function getClientIP(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '0.0.0.0';
}

const CLIENTS = [
  {
    name: 'ANDROID',
    body: {
      videoId: null,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          androidSdkVersion: 30,
          hl: 'en',
          gl: 'US',
        },
      },
    },
    headers: {
      'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '19.09.37',
    },
  },
  {
    name: 'IOS',
    body: {
      videoId: null,
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '19.09.3',
          deviceMake: 'Apple',
          deviceModel: 'iPhone14,3',
          hl: 'en',
          gl: 'US',
        },
      },
    },
    headers: {
      'User-Agent': 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
      'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': '19.09.3',
    },
  },
  {
    name: 'TV_EMBEDDED',
    body: {
      videoId: null,
      context: {
        client: {
          clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
          clientVersion: '2.0',
          hl: 'en',
          gl: 'US',
        },
        thirdParty: {
          embedUrl: 'https://www.youtube.com',
        },
      },
    },
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'X-YouTube-Client-Name': '85',
      'X-YouTube-Client-Version': '2.0',
    },
  },
];

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

  const errors = [];

  for (const client of CLIENTS) {
    try {
      const body = JSON.parse(JSON.stringify(client.body));
      body.videoId = videoId;

      const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...client.headers,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        errors.push(`${client.name}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const status = data.playabilityStatus?.status;

      if (status === 'LOGIN_REQUIRED' || status === 'ERROR') {
        errors.push(`${client.name}: ${status}`);
        continue;
      }

      if (status === 'UNPLAYABLE') {
        const reason = data.playabilityStatus.reason || '视频不可用';
        return Response.json({ error: 'unplayable', message: reason }, { status: 403 });
      }

      const details = data.videoDetails;
      const formats = [
        ...(data.streamingData?.formats || []),
        ...(data.streamingData?.adaptiveFormats || []),
      ];

      const hasUrl = formats.filter(f => f.url);

      if (!hasUrl.length) {
        errors.push(`${client.name}: no url in formats`);
        continue;
      }

      const parsed = hasUrl.map(f => ({
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
        url: f.url,
        isAudio: f.mimeType?.startsWith('audio/'),
        isVideo: f.mimeType?.startsWith('video/'),
      }));

      const videoFormats = parsed
        .filter(f => f.isVideo)
        .sort((a, b) => b.height - a.height);

      const audioFormats = parsed
        .filter(f => f.isAudio)
        .sort((a, b) => b.bitrate - a.bitrate);

      return Response.json({
        ok: true,
        client: client.name,
        title: details?.title || '',
        author: details?.author || '',
        duration: details?.lengthSeconds || '',
        thumbnail: details?.thumbnail?.thumbnails?.pop()?.url || '',
        videoId,
        videos: videoFormats.slice(0, 8),
        audios: audioFormats.slice(0, 3),
      }, { headers: rateLimitHeaders(rl) });

    } catch (err) {
      errors.push(`${client.name}: ${err.message}`);
    }
  }

  return Response.json({
    error: 'all_clients_failed',
    message: '所有解析方式均失败，该视频可能受限',
    details: errors,
    videoId,
  }, { status: 502 });
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
