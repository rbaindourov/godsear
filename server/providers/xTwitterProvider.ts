import { resolvePostPlaceInArea } from '../geocoder.js';
import type { AreaContext, GeoPost, PrecisionLevel } from '../types.js';

export async function fetchXLiveNear(
  area: AreaContext,
  radiusKm: number,
  bearerToken: string,
  customQuery?: string
): Promise<GeoPost[]> {
  const token = bearerToken.trim();
  if (!token) return [];

  const qParts: string[] = [];
  if (customQuery && !customQuery.startsWith('@')) {
    qParts.push(customQuery.trim());
  }
  qParts.push(`"${area.city}"`, '-is:retweet');

  const params = new URLSearchParams({
    query: qParts.join(' '),
    max_results: '25',
    'tweet.fields': 'created_at,geo,public_metrics,author_id,attachments',
    expansions: 'author_id,geo.place_id,attachments.media_keys',
    'user.fields': 'name,username,profile_image_url',
    'place.fields': 'full_name,geo,place_type',
    'media.fields': 'url,preview_image_url,type',
  });

  const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(4500),
  });

  if (!res.ok) {
    throw new Error(`X API v2 HTTP ${res.status}`);
  }

  const payload = (await res.json()) as {
    data?: any[];
    includes?: { users?: any[]; places?: any[]; media?: any[] };
  };

  const usersById = new Map<string, any>();
  for (const u of payload.includes?.users || []) {
    usersById.set(String(u.id), u);
  }

  const placesById = new Map<string, any>();
  for (const pl of payload.includes?.places || []) {
    placesById.set(String(pl.id), pl);
  }

  const mediaByKey = new Map<string, string>();
  for (const m of payload.includes?.media || []) {
    const u = m.url || m.preview_image_url;
    if (m.media_key && u) mediaByKey.set(String(m.media_key), String(u));
  }

  const posts: GeoPost[] = [];
  for (const t of payload.data || []) {
    const user = usersById.get(String(t.author_id));
    const username = String(user?.username || 'x_user');
    const text = String(t.text || '').trim();
    if (!text) continue;

    let lat: number | null = null;
    let lon: number | null = null;
    let precision: PrecisionLevel = 'venue';
    let placeLabel = area.displayLabel;

    if (Array.isArray(t?.geo?.coordinates?.coordinates)) {
      lon = Number(t.geo.coordinates.coordinates[0]);
      lat = Number(t.geo.coordinates.coordinates[1]);
      precision = 'exact_gps';
      placeLabel = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
    } else if (t?.geo?.place_id && placesById.has(String(t.geo.place_id))) {
      const pl = placesById.get(String(t.geo.place_id));
      const bbox = pl?.geo?.bbox; // [west, south, east, north]
      if (Array.isArray(bbox) && bbox.length === 4) {
        lon = (Number(bbox[0]) + Number(bbox[2])) / 2;
        lat = (Number(bbox[1]) + Number(bbox[3])) / 2;
        precision = pl.place_type === 'poi' ? 'venue' : 'neighborhood';
        placeLabel = String(pl.full_name || area.displayLabel);
      }
    } else {
      const resolved = await resolvePostPlaceInArea(text, area, radiusKm);
      if (resolved) {
        lat = resolved.lat;
        lon = resolved.lon;
        precision = resolved.kind;
        placeLabel = resolved.label;
      }
    }

    if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }

    const mediaKeys: string[] = t?.attachments?.media_keys || [];
    const mediaUrls = mediaKeys.map(k => mediaByKey.get(String(k)) || '').filter(Boolean);

    posts.push({
      id: `x:${t.id}`,
      platform: 'x',
      authorHandle: `@${username}`,
      authorName: String(user?.name || username),
      authorAvatar: user?.profile_image_url ? String(user.profile_image_url) : undefined,
      authorProfileUrl: `https://x.com/${encodeURIComponent(username)}`,
      text,
      mediaUrls,
      permalink: `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(String(t.id))}`,
      createdAt: t.created_at ? new Date(t.created_at).toISOString() : new Date().toISOString(),
      lat,
      lon,
      precision,
      placeLabel,
      metrics: {
        likes: Number(t?.public_metrics?.like_count || 0),
        reposts: Number(t?.public_metrics?.retweet_count || 0),
        replies: Number(t?.public_metrics?.reply_count || 0),
      },
    });
  }

  return posts;
}
