import { rateLimit, rateLimitHeaders, tooManyRequests } from '../_ratelimit.js';

function getClientIP(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '0.0.0.0';
}

export async function onRequestGet(context) {
  const ip = getClientIP(context.request);
  const rl = await rateLimit(context.env, ip);
  if (rl?.limited) return tooManyRequests(rl);

  const url = new URL(context.request.url);
  const tweetUrl = url.searchParams.get('url');
  if (!tweetUrl) {
    return Response.json({ error: 'missing url param' }, { status: 400 });
  }

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    return Response.json({ error: 'invalid twitter/x url' }, { status: 400 });
  }

  try {
    const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=hash`;
    const resp = await fetch(syndicationUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://platform.twitter.com/',
      },
    });

    if (resp.ok) {
      const data = await resp.json();
      const media = [];

      if (data.mediaDetails?.length) {
        for (const m of data.mediaDetails) {
          if (m.type === 'video' || m.type === 'animated_gif') {
            const variants = m.video_info?.variants || [];
            const mp4s = variants
              .filter(v => v.content_type === 'video/mp4')
              .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            if (mp4s.length) {
              media.push({
                type: 'video',
                url: mp4s[0].url,
                bitrate: mp4s[0].bitrate,
                variants: mp4s.map(v => ({ url: v.url, bitrate: v.bitrate })),
              });
            }
          } else if (m.type === 'photo') {
            media.push({
              type: 'photo',
              url: m.media_url_https || m.media_url + '?format=jpg&name=4096x4096',
            });
          }
        }
      }

      if (media.length) {
        return Response.json({
          ok: true,
          tweetId,
          author: data.user?.screen_name || '',
          name: data.user?.name || '',
          text: data.text || '',
          media,
        }, { headers: rateLimitHeaders(rl) });
      }
    }

    const guestResult = await tryGuestToken(tweetId);
    if (guestResult.ok) {
      return Response.json(guestResult, { headers: rateLimitHeaders(rl) });
    }

    return Response.json({
      ok: false,
      error: 'no_media',
      message: '未找到媒体内容，推文可能为纯文字或受保护',
      tweetId,
    }, { status: 404 });

  } catch (err) {
    return Response.json({ error: 'internal', message: err.message }, { status: 500 });
  }
}

async function tryGuestToken(tweetId) {
  try {
    const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    const activateResp = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BEARER}` },
    });

    if (!activateResp.ok) return { ok: false };
    const { guest_token } = await activateResp.json();
    if (!guest_token) return { ok: false };

    const tweetResp = await fetch(
      `https://api.twitter.com/graphql/V1ze5q3ijDS1VeLwLY0m7g/TweetResultByRestId?variables=%7B%22tweetId%22%3A%22${tweetId}%22%2C%22withCommunityNotes%22%3Atrue%2C%22withVoice%22%3Atrue%7D&features=%7B%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22communities_web_enable_tweet_community_results_fetch%22%3Atrue%2C%22c9s_tweet_anatomy_moderator_badge_enabled%22%3Atrue%2C%22articles_preview_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Atrue%2C%22tweet_awards_web_tipping_enabled%22%3Afalse%2C%22creator_subscriptions_quote_tweet_preview_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22rweb_video_timestamps_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Atrue%2C%22rweb_tipjar_consumption_enabled%22%3Atrue%2C%22responsive_web_graphql_exclude_directive_enabled%22%3Atrue%2C%22verified_phone_label_enabled%22%3Afalse%2C%22responsive_web_graphql_skip_user_profile_image_extensions_enabled%22%3Afalse%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%7D`,
      {
        headers: {
          'Authorization': `Bearer ${BEARER}`,
          'x-guest-token': guest_token,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }
    );

    if (!tweetResp.ok) return { ok: false };
    const tweetData = await tweetResp.json();

    const tweetResult = tweetData?.data?.tweetResult?.result;
    const legacy = tweetResult?.legacy || tweetResult?.tweet?.legacy;
    const mediaEntities = legacy?.extended_entities?.media || legacy?.entities?.media || [];

    const media = [];
    for (const m of mediaEntities) {
      if (m.type === 'video' || m.type === 'animated_gif') {
        const variants = m.video_info?.variants || [];
        const mp4s = variants
          .filter(v => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (mp4s.length) {
          media.push({
            type: m.type === 'animated_gif' ? 'gif' : 'video',
            url: mp4s[0].url,
            bitrate: mp4s[0].bitrate,
            variants: mp4s.map(v => ({ url: v.url, bitrate: v.bitrate })),
          });
        }
      } else if (m.type === 'photo') {
        media.push({
          type: 'photo',
          url: m.media_url_https + '?format=jpg&name=4096x4096',
        });
      }
    }

    if (media.length) {
      return {
        ok: true,
        tweetId,
        author: legacy?.user?.screen_name || '',
        name: legacy?.user?.name || '',
        text: legacy?.full_text || '',
        media,
      };
    }

    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function extractTweetId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:\w+)\/status(?:es)?\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
