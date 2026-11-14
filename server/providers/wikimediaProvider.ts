import type { GeoPost } from '../types.js';

const USER_AGENT = 'GodsEarOSINT/1.0 (https://godsear.webdesigner.la)';

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchWikimediaNear(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<GeoPost[]> {
  const radiusMeters = Math.min(10000, Math.max(250, Math.round(radiusKm * 1000)));
  const params = new URLSearchParams({
    action: 'query',
    generator: 'geosearch',
    ggscoord: `${lat.toFixed(5)}|${lon.toFixed(5)}`,
    ggsradius: String(radiusMeters),
    ggsnamespace: '6',
    ggslimit: '25',
    prop: 'coordinates|imageinfo',
    iiprop: 'url|user|timestamp|extmetadata',
    iiurlwidth: '640',
    format: 'json',
  });

  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) {
    throw new Error(`Wikimedia HTTP ${res.status}`);
  }

  const data = (await res.json()) as { query?: { pages?: Record<string, any> } };
  return mapWikimediaPages(data?.query?.pages || {});
}

export async function fetchWikimediaUserTrail(handle: string): Promise<GeoPost[]> {
  const clean = handle.trim().replace(/^@+/, '');
  if (!clean) return [];

  const params = new URLSearchParams({
    action: 'query',
    generator: 'allimages',
    gaiuser: clean,
    gaisort: 'timestamp',
    gaidir: 'descending',
    gailimit: '40',
    prop: 'coordinates|imageinfo',
    iiprop: 'url|user|timestamp|extmetadata',
    iiurlwidth: '640',
    format: 'json',
  });

  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { query?: { pages?: Record<string, any> } };
  return mapWikimediaPages(data?.query?.pages || {});
}

function mapWikimediaPages(pagesObj: Record<string, any>): GeoPost[] {
  const posts: GeoPost[] = [];

  for (const page of Object.values(pagesObj)) {
    const coord = Array.isArray(page?.coordinates) ? page.coordinates[0] : null;
    const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
    if (!coord || !info) continue;

    const lat = Number(coord.lat);
    const lon = Number(coord.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const user = String(info.user || 'commons_photographer');
    const cleanTitle = String(page.title || '')
      .replace(/^File:/i, '')
      .replace(/\.[a-z0-9]{3,4}$/i, '')
      .replace(/_/g, ' ')
      .trim();

    const extDesc = stripHtml(String(info?.extmetadata?.ImageDescription?.value || ''));
    const text = extDesc && extDesc.length >= 8 ? extDesc : cleanTitle;
    const thumb = info.thumburl || info.url;

    // Prefer EXIF DateTimeOriginal if parseable, otherwise upload timestamp
    const rawExifDate = stripHtml(String(info?.extmetadata?.DateTimeOriginal?.value || ''));
    const exifParsed = rawExifDate ? Date.parse(rawExifDate) : NaN;
    const uploadParsed = info.timestamp ? Date.parse(info.timestamp) : NaN;
    const createdAt = Number.isFinite(exifParsed)
      ? new Date(exifParsed).toISOString()
      : Number.isFinite(uploadParsed)
        ? new Date(uploadParsed).toISOString()
        : new Date().toISOString();

    posts.push({
      id: `commons:${page.pageid}`,
      platform: 'wikimedia',
      authorHandle: `@${user}`,
      authorName: user,
      authorProfileUrl: `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(user)}`,
      text: text.slice(0, 400),
      mediaUrls: thumb ? [String(thumb)] : [],
      permalink: String(info.descriptionurl || `https://commons.wikimedia.org/?curid=${page.pageid}`),
      createdAt,
      lat,
      lon,
      precision: 'exact_gps',
      placeLabel: cleanTitle.slice(0, 72) || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`,
    });
  }

  return posts;
}
