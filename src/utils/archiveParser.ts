import type { GeoPost, PlatformId, PrecisionLevel } from '../../server/types';

function computeBboxCentroid(bbox: number[][]): [number, number] | null {
  if (!Array.isArray(bbox) || bbox.length === 0) return null;
  let lonSum = 0;
  let latSum = 0;
  let count = 0;
  for (const pt of bbox) {
    if (Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
      lonSum += Number(pt[0]);
      latSum += Number(pt[1]);
      count++;
    }
  }
  return count > 0 ? [lonSum / count, latSum / count] : null;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Parses real X/Twitter Data Export `tweets.js` (`window.YTD.tweet.part0 = [...]`),
 * GeoJSON FeatureCollections, JSON arrays, or CSV exports containing geolocated tweets/posts.
 * Strictly drops any row without real coordinates.
 */
export function parseImportedSocialArchive(
  rawContent: string,
  defaultHandle = 'x_archive_user'
): GeoPost[] {
  const trimmed = rawContent.trim();
  if (!trimmed) return [];

  // 1. Official X/Twitter Archive `window.YTD.tweet.part0 = [...]`
  const ytdCleaned = trimmed.replace(/^window\.YTD\.[a-zA-Z0-9_.]+\s*=\s*/, '').replace(/;\s*$/, '');

  if (ytdCleaned.startsWith('[') || ytdCleaned.startsWith('{')) {
    try {
      const parsed = JSON.parse(ytdCleaned);

      // GeoJSON FeatureCollection
      if (parsed && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
        return parsed.features
          .map((feat: any, idx: number): GeoPost | null => {
            const coords = feat?.geometry?.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) return null;
            const lon = Number(coords[0]);
            const lat = Number(coords[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            const p = feat.properties || {};
            const handle = String(p.handle || p.username || p.author || defaultHandle).replace(/^@+/, '');
            const id = String(p.id || feat.id || `import-geojson-${idx}-${Date.now()}`);
            const text = String(p.text || p.full_text || p.content || p.caption || '').trim();
            if (!text) return null;
            return {
              id: `x:${id}`,
              platform: (p.platform as PlatformId) || 'x',
              authorHandle: `@${handle}`,
              authorName: String(p.authorName || p.name || handle),
              authorProfileUrl: `https://x.com/${encodeURIComponent(handle)}`,
              text,
              mediaUrls: Array.isArray(p.mediaUrls) ? p.mediaUrls : p.media_url ? [String(p.media_url)] : [],
              permalink: String(p.permalink || p.url || `https://x.com/${encodeURIComponent(handle)}/status/${id}`),
              createdAt: p.createdAt || p.created_at || p.timestamp
                ? new Date(p.createdAt || p.created_at || p.timestamp).toISOString()
                : new Date().toISOString(),
              lat,
              lon,
              precision: (p.precision as PrecisionLevel) || 'exact_gps',
              placeLabel: String(p.placeLabel || p.place || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`),
            };
          })
          .filter((x: GeoPost | null): x is GeoPost => x !== null);
      }

      // Array of X tweets or normalized JSON objects
      const items: any[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.tweets)
          ? parsed.tweets
          : Array.isArray(parsed.posts)
            ? parsed.posts
            : Array.isArray(parsed.data)
              ? parsed.data
              : [];

      const out: GeoPost[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i]?.tweet || items[i];
        if (!entry) continue;

        let lat = Number(entry.lat ?? entry.latitude);
        let lon = Number(entry.lon ?? entry.lng ?? entry.longitude);
        let precision: PrecisionLevel = (entry.precision as PrecisionLevel) || 'exact_gps';

        // X/Twitter `coordinates.coordinates` = [lon, lat]
        if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && Array.isArray(entry?.coordinates?.coordinates)) {
          lon = Number(entry.coordinates.coordinates[0]);
          lat = Number(entry.coordinates.coordinates[1]);
          precision = 'exact_gps';
        }
        // Legacy Twitter `geo.coordinates` = [lat, lon]
        if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && Array.isArray(entry?.geo?.coordinates)) {
          lat = Number(entry.geo.coordinates[0]);
          lon = Number(entry.geo.coordinates[1]);
          precision = 'exact_gps';
        }
        // X `place.bounding_box.coordinates[0]` polygon
        if (
          (!Number.isFinite(lat) || !Number.isFinite(lon)) &&
          Array.isArray(entry?.place?.bounding_box?.coordinates?.[0])
        ) {
          const centroid = computeBboxCentroid(entry.place.bounding_box.coordinates[0]);
          if (centroid) {
            [lon, lat] = centroid;
            precision = entry.place.place_type === 'poi' ? 'venue' : 'neighborhood';
          }
        }

        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          continue;
        }

        const text = String(entry.full_text || entry.text || entry.content || '').trim();
        if (!text) continue;

        const rawHandle = String(
          entry.authorHandle || entry.screen_name || entry.username || entry.user?.screen_name || defaultHandle
        ).replace(/^@+/, '');

        const tweetId = String(entry.id_str || entry.id || `import-${i}`);
        const rawDate = entry.createdAt || entry.created_at || entry.timestamp;
        const parsedMs = rawDate ? Date.parse(String(rawDate)) : NaN;

        const mediaUrls: string[] = Array.isArray(entry.mediaUrls)
          ? entry.mediaUrls
          : Array.isArray(entry?.entities?.media)
            ? entry.entities.media
                .map((m: any) => String(m?.media_url_https || m?.media_url || ''))
                .filter(Boolean)
            : [];

        const placeLabel = String(
          entry.placeLabel ||
            entry?.place?.full_name ||
            entry?.place?.name ||
            `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`
        );

        out.push({
          id: tweetId.startsWith('x:') ? tweetId : `x:${tweetId}`,
          platform: (entry.platform as PlatformId) || 'x',
          authorHandle: `@${rawHandle}`,
          authorName: String(entry.authorName || entry.user?.name || rawHandle),
          authorAvatar: entry.authorAvatar || entry.user?.profile_image_url_https || undefined,
          authorProfileUrl: String(
            entry.authorProfileUrl || `https://x.com/${encodeURIComponent(rawHandle)}`
          ),
          text,
          mediaUrls,
          permalink: String(
            entry.permalink ||
              entry.url ||
              `https://x.com/${encodeURIComponent(rawHandle)}/status/${encodeURIComponent(tweetId)}`
          ),
          createdAt: Number.isFinite(parsedMs)
            ? new Date(parsedMs).toISOString()
            : new Date().toISOString(),
          lat,
          lon,
          precision,
          placeLabel,
          metrics: {
            likes: Number(entry.favorite_count ?? entry.likes ?? 0),
            reposts: Number(entry.retweet_count ?? entry.reposts ?? 0),
          },
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  // 2. CSV Import (`lat,lon,handle,text,created_at,permalink,place`)
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim());

  const idxLat = headers.findIndex(h => h === 'lat' || h === 'latitude');
  const idxLon = headers.findIndex(h => h === 'lon' || h === 'lng' || h === 'longitude');
  const idxText = headers.findIndex(h => h === 'text' || h === 'full_text' || h === 'content' || h === 'tweet');
  const idxHandle = headers.findIndex(h => h === 'handle' || h === 'username' || h === 'author' || h === 'screen_name');
  const idxTime = headers.findIndex(h => h === 'created_at' || h === 'createdat' || h === 'timestamp' || h === 'date');
  const idxUrl = headers.findIndex(h => h === 'permalink' || h === 'url' || h === 'link');
  const idxPlace = headers.findIndex(h => h === 'place' || h === 'placelabel' || h === 'location');

  if (idxLat === -1 || idxLon === -1 || idxText === -1) return [];

  const posts: GeoPost[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = parseCsvLine(lines[r]);
    const lat = Number(cols[idxLat]);
    const lon = Number(cols[idxLon]);
    const text = (cols[idxText] || '').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !text) continue;

    const handle = (idxHandle >= 0 ? cols[idxHandle] : defaultHandle).replace(/^@+/, '') || defaultHandle;
    const rawTime = idxTime >= 0 ? cols[idxTime] : '';
    const parsedMs = rawTime ? Date.parse(rawTime) : NaN;
    const url = idxUrl >= 0 && cols[idxUrl] ? cols[idxUrl] : `https://x.com/${handle}#csv-${r}`;
    const placeLabel = idxPlace >= 0 && cols[idxPlace] ? cols[idxPlace] : `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;

    posts.push({
      id: `x:csv-${r}-${lat.toFixed(4)}-${lon.toFixed(4)}`,
      platform: 'x',
      authorHandle: `@${handle}`,
      authorName: handle,
      authorProfileUrl: `https://x.com/${encodeURIComponent(handle)}`,
      text,
      mediaUrls: [],
      permalink: url,
      createdAt: Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : new Date().toISOString(),
      lat,
      lon,
      precision: 'exact_gps',
      placeLabel,
    });
  }

  return posts;
}
