import type { GeoPost, PlatformId, ProviderStatus, SweepFilterOptions } from './types.js';

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').replace(/^u\//i, '').toLowerCase();
}

interface SweepStamp {
  sweptAtMs: number;
  providers: ProviderStatus[];
}

/**
 * Strictly ephemeral in-memory LRU spatial cache.
 * Zero disk persistence by design.
 */
export class EphemeralGeoCache {
  private readonly maxPosts: number;
  private readonly sweepTtlMs: number;
  private readonly byId = new Map<string, GeoPost>();
  private readonly byPermalink = new Map<string, string>();
  private readonly sweepStamps = new Map<string, SweepStamp>();

  constructor(maxPosts = 5000, sweepTtlMs = 3 * 60 * 1000) {
    this.maxPosts = maxPosts;
    this.sweepTtlMs = sweepTtlMs;
  }

  public makeSweepKey(lat: number, lon: number, radiusKm: number, q = ''): string {
    return `${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}:${q.trim().toLowerCase()}`;
  }

  public isSweepFresh(key: string): boolean {
    const entry = this.sweepStamps.get(key);
    if (!entry) return false;
    if (Date.now() - entry.sweptAtMs > this.sweepTtlMs) {
      this.sweepStamps.delete(key);
      return false;
    }
    return true;
  }

  public markSwept(key: string, providers: ProviderStatus[] = []): void {
    this.sweepStamps.set(key, { sweptAtMs: Date.now(), providers });
  }

  public getSweepProviders(key: string): ProviderStatus[] {
    return this.sweepStamps.get(key)?.providers || [];
  }

  public upsertMany(posts: GeoPost[]): number {
    let inserted = 0;
    for (const post of posts) {
      if (
        !post ||
        !post.id ||
        !post.permalink ||
        !Number.isFinite(post.lat) ||
        !Number.isFinite(post.lon) ||
        Math.abs(post.lat) > 90 ||
        Math.abs(post.lon) > 180
      ) {
        continue;
      }

      const existingId = this.byPermalink.get(post.permalink);
      const canonicalId = existingId || post.id;
      if (this.byId.has(canonicalId)) {
        // Refresh LRU order
        const prev = this.byId.get(canonicalId)!;
        this.byId.delete(canonicalId);
        this.byId.set(canonicalId, {
          ...prev,
          ...post,
          id: canonicalId,
        });
      } else {
        this.byId.set(canonicalId, { ...post, id: canonicalId });
        this.byPermalink.set(post.permalink, canonicalId);
        inserted++;
      }

      // Enforce LRU bound
      while (this.byId.size > this.maxPosts) {
        const oldestKey = this.byId.keys().next().value;
        if (!oldestKey) break;
        const oldest = this.byId.get(oldestKey);
        this.byId.delete(oldestKey);
        if (oldest) {
          this.byPermalink.delete(oldest.permalink);
        }
      }
    }
    return inserted;
  }

  public query(opts: SweepFilterOptions): GeoPost[] {
    const {
      lat,
      lon,
      radiusKm,
      platforms,
      exactOnly = false,
      q,
      fromIso,
      toIso,
    } = opts;

    const platformSet =
      platforms && platforms.length > 0 ? new Set<PlatformId>(platforms) : null;
    const queryLower = q ? q.trim().toLowerCase() : '';
    const handleNeedle = queryLower.startsWith('@') || queryLower.startsWith('u/')
      ? normalizeHandle(queryLower)
      : '';
    const fromMs = fromIso ? Date.parse(fromIso) : NaN;
    const toMs = toIso ? Date.parse(toIso) : NaN;

    const matched: GeoPost[] = [];
    for (const post of this.byId.values()) {
      if (platformSet && !platformSet.has(post.platform)) continue;
      if (exactOnly && post.precision !== 'exact_gps') continue;

      if (radiusKm > 0) {
        const dist = haversineKm(lat, lon, post.lat, post.lon);
        if (dist > radiusKm) continue;
      }

      const postMs = Date.parse(post.createdAt);
      if (Number.isFinite(fromMs) && Number.isFinite(postMs) && postMs < fromMs) {
        continue;
      }
      if (Number.isFinite(toMs) && Number.isFinite(postMs) && postMs > toMs) {
        continue;
      }

      if (queryLower) {
        if (handleNeedle) {
          if (!normalizeHandle(post.authorHandle).includes(handleNeedle)) continue;
        } else {
          const haystack = `${post.authorHandle} ${post.authorName} ${post.text} ${post.placeLabel}`.toLowerCase();
          if (!haystack.includes(queryLower)) continue;
        }
      }

      matched.push(post);
    }

    matched.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return matched;
  }

  public getByAuthor(handle: string, platform?: PlatformId): GeoPost[] {
    const target = normalizeHandle(handle);
    if (!target) return [];
    const results: GeoPost[] = [];
    for (const post of this.byId.values()) {
      if (platform && post.platform !== platform) continue;
      if (normalizeHandle(post.authorHandle) === target) {
        results.push(post);
      }
    }
    // Chronological ascending for movement trail (1 -> 2 -> 3)
    results.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return results;
  }

  public size(): number {
    return this.byId.size;
  }

  public clear(): void {
    this.byId.clear();
    this.byPermalink.clear();
    this.sweepStamps.clear();
  }
}
