import { resolvePostPlaceInArea } from '../geocoder.js';
import type { AreaAnchor, AreaContext, GeoPost } from '../types.js';

const USER_AGENT = 'web:godsear.spatial.reader:v1.0.0 (public-atom-rss)';

const CITY_SUBREDDIT_MAP: Record<string, string> = {
  'los angeles': 'LosAngeles',
  'santa monica': 'SantaMonica',
  'pasadena': 'pasadena',
  'long beach': 'LongBeach',
  'burbank': 'burbank',
  'glendale': 'glendale',
  'new york': 'nyc',
  'brooklyn': 'Brooklyn',
  'manhattan': 'nyc',
  'san francisco': 'sanfrancisco',
  'oakland': 'oakland',
  'san diego': 'sandiego',
  'chicago': 'chicago',
  'austin': 'Austin',
  'houston': 'houston',
  'dallas': 'Dallas',
  'seattle': 'Seattle',
  'portland': 'Portland',
  'boston': 'boston',
  'miami': 'Miami',
  'denver': 'Denver',
  'phoenix': 'phoenix',
  'las vegas': 'vegaslocals',
  'atlanta': 'Atlanta',
  'washington': 'washingtondc',
  'philadelphia': 'philadelphia',
  'toronto': 'toronto',
  'vancouver': 'vancouver',
  'london': 'london',
  'tokyo': 'tokyo',
  'paris': 'paris',
  'berlin': 'berlin',
  'sydney': 'sydney',
  'melbourne': 'melbourne',
};

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function stripHtmlTags(html: string): string {
  return decodeXmlEntities(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a [^>]*>\[link\]<\/a>/gi, ' ')
    .replace(/<a [^>]*>\[comments\]<\/a>/gi, ' ')
    .replace(/submitted by\s+\/u\/\S+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ParsedAtomEntry {
  id: string;
  title: string;
  bodyText: string;
  author: string;
  permalink: string;
  published: string;
  thumbnail?: string;
}

function parseRedditAtomXml(xml: string): ParsedAtomEntry[] {
  const entries: ParsedAtomEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const id = block.match(/<id>([\s\S]*?)<\/id>/i)?.[1]?.trim() || '';
    const rawTitle = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '';
    const title = decodeXmlEntities(rawTitle).trim();

    const rawAuthor =
      block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i)?.[1] || '';
    const author = rawAuthor.replace(/^\/?u\//i, '').trim() || 'redditor';

    const linkHref =
      block.match(/<link[^>]+href="([^"]+)"/i)?.[1] || '';
    const permalink = decodeXmlEntities(linkHref);

    const published =
      block.match(/<published>([\s\S]*?)<\/published>/i)?.[1]?.trim() ||
      block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1]?.trim() ||
      new Date().toISOString();

    const rawContent = block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] || '';
    const decodedHtml = decodeXmlEntities(rawContent);
    const bodyText = stripHtmlTags(decodedHtml);

    const mediaThumb =
      block.match(/<media:thumbnail[^>]+url="([^"]+)"/i)?.[1] ||
      decodedHtml.match(/https:\/\/(?:i\.redd\.it|preview\.redd\.it)\/[^\s"'<>]+/i)?.[0];

    if (id && title && permalink) {
      entries.push({
        id,
        title,
        bodyText,
        author,
        permalink,
        published,
        thumbnail: mediaThumb ? decodeXmlEntities(mediaThumb) : undefined,
      });
    }
  }

  return entries;
}

export async function fetchRedditForArea(
  area: AreaContext,
  radiusKm: number,
  customQuery?: string
): Promise<GeoPost[]> {
  const citySub = CITY_SUBREDDIT_MAP[area.city.toLowerCase()];
  const specificAnchors = area.anchors.filter(a => a.kind !== 'city').slice(0, 2);

  const rssTargets: Array<{ url: string; defaultAnchor?: AreaAnchor }> = [];

  if (citySub) {
    if (customQuery && !customQuery.startsWith('@')) {
      rssTargets.push({
        url: `https://www.reddit.com/r/${citySub}/search.rss?q=${encodeURIComponent(customQuery)}&restrict_sr=1&sort=new&limit=20`,
        defaultAnchor: specificAnchors[0],
      });
    } else {
      rssTargets.push({
        url: `https://www.reddit.com/r/${citySub}/new.rss?limit=20`,
      });
    }
  } else {
    const searchTerm = customQuery
      ? `${customQuery} "${area.city}"`
      : specificAnchors[0]
        ? `"${specificAnchors[0].name}" "${area.city}"`
        : `"${area.city}"`;
    rssTargets.push({
      url: `https://www.reddit.com/search.rss?q=${encodeURIComponent(searchTerm)}&sort=new&limit=20`,
      defaultAnchor: specificAnchors[0],
    });
  }

  const batches = await Promise.all(
    rssTargets.slice(0, 1).map(async target => {
      try {
        const res = await fetch(target.url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, text/xml' },
          signal: AbortSignal.timeout(4500),
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRedditAtomXml(xml).map(entry => ({
          entry,
          defaultAnchor: target.defaultAnchor,
        }));
      } catch {
        return [];
      }
    })
  );

  const seenLinks = new Set<string>();
  const posts: GeoPost[] = [];

  for (const { entry, defaultAnchor } of batches.flat()) {
    if (seenLinks.has(entry.permalink)) continue;
    seenLinks.add(entry.permalink);

    const combinedText = entry.bodyText
      ? `${entry.title} — ${entry.bodyText}`
      : entry.title;

    const place =
      (await resolvePostPlaceInArea(combinedText, area, radiusKm, defaultAnchor)) ||
      (citySub
        ? {
            name: area.city,
            kind: 'city' as const,
            lat: area.centerLat,
            lon: area.centerLon,
            label: area.state ? `${area.city}, ${area.state}` : area.city,
          }
        : null);

    if (!place) continue;

    const createdMs = Date.parse(entry.published);
    posts.push({
      id: `reddit:${entry.id}`,
      platform: 'reddit',
      authorHandle: `u/${entry.author}`,
      authorName: entry.author,
      authorProfileUrl: `https://www.reddit.com/user/${encodeURIComponent(entry.author)}`,
      text: combinedText.slice(0, 480),
      mediaUrls: entry.thumbnail ? [entry.thumbnail] : [],
      permalink: entry.permalink,
      createdAt: Number.isFinite(createdMs)
        ? new Date(createdMs).toISOString()
        : new Date().toISOString(),
      lat: place.lat,
      lon: place.lon,
      precision: place.kind,
      placeLabel: place.label,
    });
  }

  return posts;
}
