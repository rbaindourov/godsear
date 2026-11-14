import { resolvePostPlaceInArea } from '../geocoder.js';
import type { AreaAnchor, AreaContext, GeoPost } from '../types.js';

const USER_AGENT = 'GodsEarOSINT/1.0 (+https://godsear.webdesigner.la)';

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERIC_DISTRICT_TAGS = new Set([
  'downtown',
  'central',
  'midtown',
  'uptown',
  'westside',
  'eastside',
  'northside',
  'southside',
  'chinatown',
  'koreatown',
  'littleitaly',
  'oldtown',
  'civiccenter',
  'artsdistrict',
  'financialdistrict',
  'historiccore',
]);

function toHashtag(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function fetchMastodonForArea(
  area: AreaContext,
  radiusKm: number,
  customQuery?: string
): Promise<GeoPost[]> {
  const tags: Array<{ tag: string; anchor?: AreaAnchor; requireCityMatch?: boolean }> = [];

  if (customQuery && !customQuery.startsWith('@')) {
    const cleanTag = toHashtag(customQuery);
    if (cleanTag.length >= 3) {
      tags.push({ tag: cleanTag, anchor: area.anchors[0], requireCityMatch: true });
    }
  }

  const districtAnchor = area.anchors.find(a => a.kind === 'neighborhood');
  if (districtAnchor) {
    const dTag = toHashtag(districtAnchor.name);
    if (dTag.length >= 4 && !GENERIC_DISTRICT_TAGS.has(dTag)) {
      tags.push({ tag: dTag, anchor: districtAnchor });
    }
  }

  const cityTag = toHashtag(area.city);
  if (cityTag.length >= 3) {
    tags.push({
      tag: cityTag,
      anchor: {
        name: area.city,
        kind: 'city',
        lat: area.centerLat,
        lon: area.centerLon,
        label: area.state ? `${area.city}, ${area.state}` : area.city,
      },
    });
  }

  if (area.city.toLowerCase() === 'los angeles') {
    const dtlaAnchor = area.anchors.find(a => a.name.toLowerCase() === 'downtown');
    if (dtlaAnchor) {
      tags.unshift({ tag: 'dtla', anchor: dtlaAnchor });
    }
  }

  const uniqueTags = tags
    .filter((item, idx, arr) => arr.findIndex(x => x.tag === item.tag) === idx)
    .slice(0, 2);

  const batches = await Promise.all(
    uniqueTags.map(async ({ tag, anchor, requireCityMatch }) => {
      try {
        const res = await fetch(
          `https://mastodon.social/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=16`,
          {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(4200),
          }
        );
        if (!res.ok) return [];
        const statuses = (await res.json()) as any[];
        return (Array.isArray(statuses) ? statuses : []).map(s => ({
          status: s,
          defaultAnchor: anchor,
          requireCityMatch: Boolean(requireCityMatch),
        }));
      } catch {
        return [];
      }
    })
  );

  const seenUrls = new Set<string>();
  const posts: GeoPost[] = [];
  const cityLower = area.city.toLowerCase();
  const cityTagLower = toHashtag(area.city);

  const candidates: Array<{ status: any; text: string; url: string; defaultAnchor?: AreaAnchor }> = [];
  for (const { status, defaultAnchor, requireCityMatch } of batches.flat()) {
    const url = String(status?.url || status?.uri || '');
    const text = stripHtml(String(status?.content || ''));
    if (!url || !text || seenUrls.has(url)) continue;

    const lowerText = text.toLowerCase();
    // Disambiguate Los Angeles, CA from Los Ángeles, Biobío, Chile
    if (
      cityLower === 'los angeles' &&
      area.countryCode?.toUpperCase() === 'US' &&
      (url.includes('mastodon.cl/') || lowerText.includes('biobío') || lowerText.includes('biobio') || lowerText.includes('los ángeles'))
    ) {
      continue;
    }

    if (
      requireCityMatch &&
      !lowerText.includes(cityLower) &&
      !lowerText.includes(cityTagLower)
    ) {
      continue;
    }

    seenUrls.add(url);
    candidates.push({ status, text, url, defaultAnchor });
  }

  const resolvedList = await Promise.all(
    candidates.slice(0, 20).map(async ({ status, text, url, defaultAnchor }) => {
      const place = await resolvePostPlaceInArea(text, area, radiusKm, defaultAnchor);
      if (!place) return null;

      const acct = String(status?.account?.acct || status?.account?.username || 'fediverse');
      const authorName = String(status?.account?.display_name || acct);
      const mediaUrls: string[] = Array.isArray(status?.media_attachments)
        ? status.media_attachments
            .filter((m: any) => m?.type === 'image' && (m?.preview_url || m?.url))
            .map((m: any) => String(m.preview_url || m.url))
            .slice(0, 3)
        : [];

      const createdMs = Date.parse(String(status?.created_at || ''));

      const post: GeoPost = {
        id: `masto:${status.id}`,
        platform: 'mastodon',
        authorHandle: `@${acct}`,
        authorName,
        authorAvatar: status?.account?.avatar ? String(status.account.avatar) : undefined,
        authorProfileUrl: String(status?.account?.url || url),
        text: text.slice(0, 480),
        mediaUrls,
        permalink: url,
        createdAt: Number.isFinite(createdMs)
          ? new Date(createdMs).toISOString()
          : new Date().toISOString(),
        lat: place.lat,
        lon: place.lon,
        precision: place.kind,
        placeLabel: place.label,
        metrics: {
          likes: Number(status?.favourites_count || 0),
          reposts: Number(status?.reblogs_count || 0),
          replies: Number(status?.replies_count || 0),
        },
      };
      return post;
    })
  );

  for (const p of resolvedList) {
    if (p) posts.push(p);
  }

  return posts;
}
