import { haversineKm } from './memoryCache.js';
import type { AreaAnchor, AreaContext, PrecisionLevel } from './types.js';

const USER_AGENT = 'GodsEarOSINT/1.0 (+https://godsear.webdesigner.la)';

interface PhotonFeature {
  geometry?: {
    type?: string;
    coordinates?: [number, number];
  };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    suburb?: string;
    locality?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
}

const forwardGeoCache = new Map<string, AreaAnchor | null>();
const reverseGeoCache = new Map<string, AreaContext>();

function setBounded<K, V>(map: Map<K, V>, key: K, val: V, max = 800): void {
  if (map.size >= max) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, val);
}

function classifyOsmPrecision(props: PhotonFeature['properties']): PrecisionLevel {
  const t = String(props?.type || '').toLowerCase();
  const key = String(props?.osm_key || '').toLowerCase();
  if (
    t === 'house' ||
    t === 'street' ||
    key === 'amenity' ||
    key === 'tourism' ||
    key === 'leisure' ||
    key === 'shop' ||
    key === 'railway' ||
    key === 'aeroway' ||
    key === 'building' ||
    key === 'highway'
  ) {
    return 'venue';
  }
  if (t === 'district' || t === 'locality' || props?.district || props?.suburb) {
    return 'neighborhood';
  }
  return 'city';
}

function formatPhotonLabel(props: PhotonFeature['properties'], fallbackCity: string): string {
  if (!props) return fallbackCity;
  const parts: string[] = [];
  if (props.name) {
    parts.push(props.name);
  } else if (props.housenumber && props.street) {
    parts.push(`${props.housenumber} ${props.street}`);
  } else if (props.street) {
    parts.push(props.street);
  }
  if (props.district && !parts.includes(props.district)) {
    parts.push(props.district);
  }
  const city = props.city || props.county || fallbackCity;
  if (city && !parts.includes(city)) {
    parts.push(city);
  }
  return parts.slice(0, 3).join(', ') || fallbackCity;
}

async function photonReverseSingle(lat: number, lon: number): Promise<PhotonFeature | null> {
  try {
    const url = `https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(3200),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { features?: PhotonFeature[] };
    return json.features?.[0] || null;
  } catch {
    return null;
  }
}

async function nominatimReverseFallback(
  lat: number,
  lon: number
): Promise<{
  street?: string;
  district?: string;
  city?: string;
  state?: string;
  country?: string;
  countryCode?: string;
} | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'en',
      },
      signal: AbortSignal.timeout(3200),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const addr = data?.address || {};
    const city =
      addr.city ||
      addr.town ||
      addr.municipality ||
      addr.village ||
      addr.county ||
      undefined;
    const district =
      addr.suburb ||
      addr.neighbourhood ||
      addr.city_district ||
      addr.quarter ||
      addr.borough ||
      undefined;
    const street = data?.name || addr.road || addr.pedestrian || undefined;
    return {
      street,
      district,
      city,
      state: addr.state,
      country: addr.country,
      countryCode: addr.country_code ? String(addr.country_code).toUpperCase() : undefined,
    };
  } catch {
    return null;
  }
}

async function bigDataCloudReverseFallback(
  lat: number,
  lon: number
): Promise<{
  district?: string;
  city?: string;
  state?: string;
  country?: string;
  countryCode?: string;
} | null> {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}&localityLanguage=en`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return {
      district: data?.locality !== data?.city ? data?.locality : undefined,
      city: data?.city || data?.locality || undefined,
      state: data?.principalSubdivision || undefined,
      country: data?.countryName || undefined,
      countryCode: data?.countryCode || undefined,
    };
  } catch {
    return null;
  }
}

export async function discoverAreaContext(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<AreaContext> {
  const cacheKey = `${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}`;
  const cached = reverseGeoCache.get(cacheKey);
  if (cached) return cached;

  // Single primary Photon reverse lookup (avoids multi-request 429 bursts)
  const centerFeat = await photonReverseSingle(lat, lon);
  const primary = centerFeat?.properties;

  let city = primary?.city || primary?.locality || primary?.county || '';
  let district = primary?.district || primary?.suburb || primary?.locality;
  let street = primary?.name || primary?.street;
  let state = primary?.state;
  let country = primary?.country;
  let countryCode = primary?.countrycode;

  // Resilient fallback chain if Photon rate-limits or omits municipality
  if (!city) {
    const nom = await nominatimReverseFallback(lat, lon);
    if (nom?.city) {
      city = nom.city;
      district = district || nom.district;
      street = street || nom.street;
      state = state || nom.state;
      country = country || nom.country;
      countryCode = countryCode || nom.countryCode;
    }
  }
  if (!city) {
    const bdc = await bigDataCloudReverseFallback(lat, lon);
    if (bdc?.city) {
      city = bdc.city;
      district = district || bdc.district;
      state = state || bdc.state;
      country = country || bdc.country;
      countryCode = countryCode || bdc.countryCode;
    }
  }

  if (!city) {
    city = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
  }

  const anchors: AreaAnchor[] = [];
  const seenNames = new Set<string>();

  const pushAnchor = (name: string | undefined, kind: PrecisionLevel, aLat: number, aLon: number) => {
    const clean = name?.trim();
    if (!clean || clean.length < 3 || /^\d+$/.test(clean) || clean.includes('°')) return;
    const key = clean.toLowerCase();
    if (seenNames.has(key)) return;
    seenNames.add(key);
    anchors.push({
      name: clean,
      kind,
      lat: aLat,
      lon: aLon,
      label: clean === city ? (state ? `${city}, ${state}` : city) : `${clean}, ${city}`,
    });
  };

  const [cLon, cLat] = centerFeat?.geometry?.coordinates || [lon, lat];
  pushAnchor(district, 'neighborhood', cLat, cLon);
  pushAnchor(street, 'venue', cLat, cLon);
  pushAnchor(city, 'city', lat, lon);

  const displayParts = [street || district, city, state || country].filter(Boolean);
  const displayLabel =
    Array.from(new Set(displayParts)).slice(0, 3).join(', ') ||
    `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;

  const context: AreaContext = {
    centerLat: lat,
    centerLon: lon,
    displayLabel,
    street,
    district,
    city,
    state,
    country,
    countryCode,
    anchors,
  };

  setBounded(reverseGeoCache, cacheKey, context);
  return context;
}

export async function forwardGeocodeSearch(
  query: string
): Promise<{ lat: number; lon: number; label: string } | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Check literal "lat, lon" coordinate input first
  const coordMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coordMatch) {
    const lat = Number(coordMatch[1]);
    const lon = Number(coordMatch[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon, label: `${lat.toFixed(4)}°, ${lon.toFixed(4)}°` };
    }
  }

  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(trimmed)}&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { features?: PhotonFeature[] };
    const f = json.features?.[0];
    if (!f?.geometry?.coordinates) return null;
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    const label = [p?.name || p?.street, p?.district, p?.city, p?.state, p?.country]
      .filter(Boolean)
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .slice(0, 3)
      .join(', ');
    return { lat, lon, label: label || trimmed };
  } catch {
    return null;
  }
}

const STREET_OR_VENUE_PATTERNS: RegExp[] = [
  // Intersections: "Sunset and Vine", "Wilshire & Western"
  /\b([A-Z][a-zA-Z0-9.'-]{2,20}(?:\s+[A-Z][a-zA-Z0-9.'-]{2,20})?\s+(?:and|&|at|\/)\s+[A-Z][a-zA-Z0-9.'-]{2,20}(?:\s+(?:St|Ave|Blvd|Rd|Way|Dr))?)\b/,
  // Named streets, boulevards, landmarks, parks, stations, beaches, airports
  /\b([A-Z][a-zA-Z0-9'-]+(?:\s+[A-Z][a-zA-Z0-9'-]+){0,3}\s+(?:Blvd|Boulevard|Ave|Avenue|St|Street|Rd|Road|Pkwy|Parkway|Hwy|Freeway|Park|Beach|Pier|Station|Airport|Observatory|Center|Arena|Stadium|Plaza|Square|Market|Bridge|Canyon|Hills|Village))\b/,
  // Prepositional place phrases: "in Silver Lake", "at Dodger Stadium", "near Echo Park"
  /\b(?:at|in|near|around|outside|from)\s+([A-Z][a-zA-Z'-]{2,22}(?:\s+[A-Z][a-zA-Z'-]{2,22}){0,2})\b/,
];

const PLACE_STOPWORDS = new Set([
  'the',
  'this',
  'that',
  'today',
  'tonight',
  'morning',
  'afternoon',
  'california',
  'united states',
  'america',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/**
 * Resolves a real post's text to the most specific real-world street, venue, or neighborhood
 * inside the active sweep cone — ZERO synthetic jitter.
 */
export async function resolvePostPlaceInArea(
  text: string,
  area: AreaContext,
  maxRadiusKm: number,
  fallbackAnchor?: AreaAnchor
): Promise<AreaAnchor | null> {
  // 1. Check if post explicitly names one of the discovered local neighborhood/street anchors
  const lowerText = text.toLowerCase();
  for (const anchor of area.anchors) {
    if (anchor.kind !== 'city' && lowerText.includes(anchor.name.toLowerCase())) {
      return anchor;
    }
  }

  // 2. Extract candidate street, intersection, or venue phrase from post text and geocode via Photon
  const candidates: string[] = [];
  for (const regex of STREET_OR_VENUE_PATTERNS) {
    const match = text.match(regex);
    if (match?.[1]) {
      const candidate = match[1].trim();
      if (
        candidate.length >= 4 &&
        !PLACE_STOPWORDS.has(candidate.toLowerCase()) &&
        candidate.toLowerCase() !== area.city.toLowerCase()
      ) {
        candidates.push(candidate);
      }
    }
  }

  for (const candidate of candidates.slice(0, 2)) {
    const cacheKey = `${candidate.toLowerCase()}|${area.city.toLowerCase()}`;
    if (forwardGeoCache.has(cacheKey)) {
      const hit = forwardGeoCache.get(cacheKey);
      if (hit && haversineKm(area.centerLat, area.centerLon, hit.lat, hit.lon) <= Math.max(maxRadiusKm * 1.4, 8)) {
        return hit;
      }
      continue;
    }

    try {
      const q = `${candidate}, ${area.city}${area.state ? `, ${area.state}` : ''}`;
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${area.centerLat.toFixed(4)}&lon=${area.centerLon.toFixed(4)}&limit=2`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(2200),
      });
      if (res.ok) {
        const json = (await res.json()) as { features?: PhotonFeature[] };
        const valid = (json.features || []).find(f => {
          if (!f.geometry?.coordinates) return false;
          const [fLon, fLat] = f.geometry.coordinates;
          return haversineKm(area.centerLat, area.centerLon, fLat, fLon) <= Math.max(maxRadiusKm * 1.4, 8);
        });
        if (valid?.geometry?.coordinates) {
          const [vLon, vLat] = valid.geometry.coordinates;
          const kind = classifyOsmPrecision(valid.properties);
          const resolved: AreaAnchor = {
            name: valid.properties?.name || candidate,
            kind,
            lat: vLat,
            lon: vLon,
            label: formatPhotonLabel(valid.properties, area.city),
          };
          setBounded(forwardGeoCache, cacheKey, resolved);
          return resolved;
        }
      }
      setBounded(forwardGeoCache, cacheKey, null);
    } catch {
      // Fall through cleanly
    }
  }

  if (fallbackAnchor) return fallbackAnchor;

  // 3. Only if the post explicitly mentions the city/district itself, anchor to true city/district center
  if (area.district && lowerText.includes(area.district.toLowerCase())) {
    const distAnchor = area.anchors.find(
      a => a.name.toLowerCase() === area.district!.toLowerCase()
    );
    if (distAnchor) return distAnchor;
  }
  if (lowerText.includes(area.city.toLowerCase())) {
    return {
      name: area.city,
      kind: 'city',
      lat: area.centerLat,
      lon: area.centerLon,
      label: area.state ? `${area.city}, ${area.state}` : area.city,
    };
  }

  return null;
}
