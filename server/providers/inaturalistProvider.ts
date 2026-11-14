import type { GeoPost } from '../types.js';

const USER_AGENT = 'GodsEarOSINT/1.0 (+https://godsear.webdesigner.la)';

export async function fetchInaturalistNear(
  lat: number,
  lon: number,
  radiusKm: number,
  q?: string
): Promise<GeoPost[]> {
  const clampedRadius = Math.max(0.25, Math.min(50, radiusKm));
  const params = new URLSearchParams({
    lat: lat.toFixed(5),
    lng: lon.toFixed(5),
    radius: String(clampedRadius),
    per_page: '28',
    order_by: 'created_at',
    order: 'desc',
    photos: 'true',
    geoprivacy: 'open',
  });
  if (q && !q.startsWith('@')) {
    params.set('q', q.trim());
  }

  const res = await fetch(`https://api.inaturalist.org/v1/observations?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) {
    throw new Error(`iNaturalist HTTP ${res.status}`);
  }

  const data = (await res.json()) as { results?: any[] };
  return mapInatObservations(data.results || []);
}

export async function fetchInaturalistUserTrail(handle: string): Promise<GeoPost[]> {
  const clean = handle.trim().replace(/^@+/, '');
  if (!clean) return [];

  const params = new URLSearchParams({
    user_login: clean,
    'has[]': 'geo',
    geoprivacy: 'open',
    per_page: '35',
    order_by: 'observed_on',
    order: 'desc',
  });

  const res = await fetch(`https://api.inaturalist.org/v1/observations?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: any[] };
  return mapInatObservations(data.results || []);
}

function mapInatObservations(results: any[]): GeoPost[] {
  const posts: GeoPost[] = [];

  for (const obs of results) {
    const coords = obs?.geojson?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (obs.obscured || obs.geoprivacy === 'obscured' || obs.geoprivacy === 'private') {
      continue;
    }

    const login = String(obs?.user?.login || 'field_observer');
    const authorName = String(obs?.user?.name || login);
    const avatar = obs?.user?.icon_url || obs?.user?.icon || undefined;

    const species =
      obs?.taxon?.preferred_common_name ||
      obs?.species_guess ||
      obs?.taxon?.name ||
      'Field observation';
    const notes = String(obs?.description || '').replace(/\s+/g, ' ').trim();
    const placeGuess = String(obs?.place_guess || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`).trim();

    const text = notes
      ? `${species} — ${notes}`
      : `Spotted ${species} at ${placeGuess}.`;

    const mediaUrls: string[] = Array.isArray(obs?.photos)
      ? obs.photos
          .map((p: any) => String(p?.url || '').replace('/square.', '/medium.'))
          .filter(Boolean)
          .slice(0, 3)
      : [];

    const rawTime = obs?.time_observed_at || obs?.created_at || new Date().toISOString();
    const parsedMs = Date.parse(rawTime);
    const createdAt = Number.isFinite(parsedMs)
      ? new Date(parsedMs).toISOString()
      : new Date().toISOString();

    const accuracy = Number(obs?.positional_accuracy || obs?.public_positional_accuracy);

    posts.push({
      id: `inat:${obs.id}`,
      platform: 'inaturalist',
      authorHandle: `@${login}`,
      authorName,
      authorAvatar: avatar,
      authorProfileUrl: `https://www.inaturalist.org/people/${encodeURIComponent(login)}`,
      text: text.slice(0, 420),
      mediaUrls,
      permalink: `https://www.inaturalist.org/observations/${obs.id}`,
      createdAt,
      lat,
      lon,
      accuracyMeters: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : undefined,
      precision: 'exact_gps',
      placeLabel: placeGuess,
      metrics: {
        likes: Number(obs?.faves_count || 0),
        replies: Number(obs?.comments_count || 0),
      },
    });
  }

  return posts;
}
