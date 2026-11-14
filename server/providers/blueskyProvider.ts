import { resolvePostPlaceInArea, forwardGeocodeSearch } from '../geocoder.js';
import type { AreaAnchor, AreaContext, GeoPost } from '../types.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; GodsEarOSINT/1.0; +https://godsear.webdesigner.la)';

function buildBskyPermalink(handle: string, uri: string): string {
  const rkey = uri.split('/').pop() || '';
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`;
}

function extractBskyImages(embed: any): string[] {
  if (!embed) return [];
  if (Array.isArray(embed.images)) {
    return embed.images
      .map((img: any) => String(img?.thumb || img?.fullsize || ''))
      .filter(Boolean)
      .slice(0, 3);
  }
  if (Array.isArray(embed?.media?.images)) {
    return embed.media.images
      .map((img: any) => String(img?.thumb || img?.fullsize || ''))
      .filter(Boolean)
      .slice(0, 3);
  }
  return [];
}

export async function fetchBlueskyForArea(
  area: AreaContext,
  radiusKm: number,
  customQuery?: string
): Promise<GeoPost[]> {
  // Build up to 2 concrete local search queries (specific district/street + city)
  const queries: Array<{ q: string; anchor?: AreaAnchor }> = [];

  if (customQuery && !customQuery.startsWith('@')) {
    queries.push({
      q: `${customQuery.trim()} "${area.city}"`,
      anchor: area.anchors[0],
    });
  } else {
    const specificAnchors = area.anchors.filter(a => a.kind !== 'city').slice(0, 2);
    for (const anchor of specificAnchors) {
      queries.push({
        q: `"${anchor.name}" "${area.city}"`,
        anchor,
      });
    }
    queries.push({
      q: `"${area.city}"`,
    });
  }

  const uniqueQueries = queries.slice(0, 2);
  const rawBatches = await Promise.all(
    uniqueQueries.map(async item => {
      try {
        const params = new URLSearchParams({
          q: item.q,
          sort: 'latest',
          limit: '18',
        });
        const res = await fetch(
          `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?${params.toString()}`,
          {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(4200),
          }
        );
        if (!res.ok) return [];
        const json = (await res.json()) as { posts?: any[] };
        return (json.posts || []).map(p => ({ raw: p, defaultAnchor: item.anchor }));
      } catch {
        return [];
      }
    })
  );

  const flat = rawBatches.flat();
  const seenUris = new Set<string>();
  const resolvedPosts: GeoPost[] = [];

  for (const { raw, defaultAnchor } of flat) {
    const uri = String(raw?.uri || '');
    const handle = String(raw?.author?.handle || '');
    const text = String(raw?.record?.text || '').trim();
    if (!uri || !handle || !text || seenUris.has(uri)) continue;
    seenUris.add(uri);

    const place = await resolvePostPlaceInArea(text, area, radiusKm, defaultAnchor);
    if (!place) continue;

    const createdMs = Date.parse(String(raw?.record?.createdAt || raw?.indexedAt || ''));
    const createdAt = Number.isFinite(createdMs)
      ? new Date(createdMs).toISOString()
      : new Date().toISOString();

    resolvedPosts.push({
      id: `bsky:${uri}`,
      platform: 'bluesky',
      authorHandle: `@${handle}`,
      authorName: String(raw?.author?.displayName || handle),
      authorAvatar: raw?.author?.avatar ? String(raw.author.avatar) : undefined,
      authorProfileUrl: `https://bsky.app/profile/${encodeURIComponent(handle)}`,
      text: text.slice(0, 480),
      mediaUrls: extractBskyImages(raw?.embed),
      permalink: buildBskyPermalink(handle, uri),
      createdAt,
      lat: place.lat,
      lon: place.lon,
      precision: place.kind,
      placeLabel: place.label,
      metrics: {
        likes: Number(raw?.likeCount || 0),
        reposts: Number(raw?.repostCount || 0),
        replies: Number(raw?.replyCount || 0),
      },
    });
  }

  return resolvedPosts;
}

export async function fetchBlueskyUserTrail(handle: string): Promise<GeoPost[]> {
  let actor = handle.trim().replace(/^@+/, '');
  if (!actor) return [];
  if (!actor.includes('.')) {
    actor = `${actor}.bsky.social`;
  }

  try {
    const params = new URLSearchParams({ actor, limit: '35' });
    const res = await fetch(
      `https://api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?${params.toString()}`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(4200),
      }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { feed?: Array<{ post?: any }> };
    const results: GeoPost[] = [];

    for (const item of json.feed || []) {
      const post = item?.post;
      const text = String(post?.record?.text || '').trim();
      if (!post?.uri || !text) continue;

      // Look for explicit "in <City/Place>" or "at <Venue>" phrases
      const locMatch = text.match(
        /\b(?:in|at|from|visiting|leaving|landed in)\s+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\b/
      );
      if (!locMatch?.[1]) continue;

      const geocoded = await forwardGeocodeSearch(locMatch[1]);
      if (!geocoded) continue;

      const authorHandle = String(post.author?.handle || actor);
      const createdMs = Date.parse(String(post.record?.createdAt || post.indexedAt || ''));

      results.push({
        id: `bsky:${post.uri}`,
        platform: 'bluesky',
        authorHandle: `@${authorHandle}`,
        authorName: String(post.author?.displayName || authorHandle),
        authorAvatar: post.author?.avatar ? String(post.author.avatar) : undefined,
        authorProfileUrl: `https://bsky.app/profile/${encodeURIComponent(authorHandle)}`,
        text: text.slice(0, 480),
        mediaUrls: extractBskyImages(post.embed),
        permalink: buildBskyPermalink(authorHandle, post.uri),
        createdAt: Number.isFinite(createdMs)
          ? new Date(createdMs).toISOString()
          : new Date().toISOString(),
        lat: geocoded.lat,
        lon: geocoded.lon,
        precision: 'venue',
        placeLabel: geocoded.label,
        metrics: {
          likes: Number(post.likeCount || 0),
          reposts: Number(post.repostCount || 0),
          replies: Number(post.replyCount || 0),
        },
      });
    }

    return results;
  } catch {
    return [];
  }
}
