import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { discoverAreaContext, forwardGeocodeSearch } from './geocoder.js';
import { EphemeralGeoCache, haversineKm, normalizeHandle } from './memoryCache.js';
import { fetchBlueskyForArea, fetchBlueskyUserTrail } from './providers/blueskyProvider.js';
import { fetchInaturalistNear, fetchInaturalistUserTrail } from './providers/inaturalistProvider.js';
import { fetchMastodonForArea } from './providers/mastodonProvider.js';
import { fetchRedditForArea } from './providers/redditProvider.js';
import { fetchWikimediaNear, fetchWikimediaUserTrail } from './providers/wikimediaProvider.js';
import { fetchXLiveNear } from './providers/xTwitterProvider.js';
import { parseImportedSocialArchive } from '../src/utils/archiveParser.js';
import type {
  GeoPost,
  PlatformId,
  ProviderStatus,
  SweepResponse,
  UserTrailResponse,
} from './types.js';

const ALL_PLATFORMS: PlatformId[] = [
  'x',
  'bluesky',
  'reddit',
  'mastodon',
  'inaturalist',
  'wikimedia',
];

export interface CreateGodsEarAppOptions {
  cache?: EphemeralGeoCache;
  disableExternalFetch?: boolean;
}

export function createApp(options: CreateGodsEarAppOptions = {}) {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  const cache = options.cache || new EphemeralGeoCache(5000, 3 * 60 * 1000);
  const disableExternal = Boolean(options.disableExternalFetch);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'godsear',
      storage: 'ephemeral-in-memory',
      cachedSignals: cache.size(),
      xLiveConfigured: Boolean(process.env.X_BEARER_TOKEN),
    });
  });

  app.get('/api/geocode', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.status(400).json({ error: 'Missing query parameter q' });
      return;
    }
    const found = await forwardGeocodeSearch(q);
    if (!found) {
      res.status(404).json({ error: `No location match found for "${q}"` });
      return;
    }
    res.json(found);
  });

  app.get('/api/sweep', async (req, res) => {
    const lat = Number(req.query.lat ?? 34.0522);
    const lon = Number(req.query.lon ?? -118.2437);
    const radiusKm = Math.max(0.25, Math.min(50, Number(req.query.radiusKm ?? 5)));

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.status(400).json({ error: 'Invalid lat/lon coordinates' });
      return;
    }

    const q = String(req.query.q || '').trim();
    const exactOnly = req.query.exactOnly === 'true';
    const force = req.query.force === 'true';
    const fromIso = req.query.from ? String(req.query.from) : undefined;
    const toIso = req.query.to ? String(req.query.to) : undefined;

    const rawPlatforms = String(req.query.platforms || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter((s): s is PlatformId => ALL_PLATFORMS.includes(s as PlatformId));
    const platforms = rawPlatforms.length > 0 ? rawPlatforms : undefined;

    const xBearer =
      String(req.header('x-twitter-bearer') || process.env.X_BEARER_TOKEN || '').trim();

    const area = disableExternal
      ? {
          centerLat: lat,
          centerLon: lon,
          displayLabel: `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`,
          city: 'Test Sector',
          anchors: [],
        }
      : await discoverAreaContext(lat, lon, radiusKm);

    const sweepKey = cache.makeSweepKey(lat, lon, radiusKm, q);
    const providers: ProviderStatus[] = [];

    if (!disableExternal && (force || !cache.isSweepFresh(sweepKey))) {
      const activeSet = new Set<PlatformId>(platforms || ALL_PLATFORMS);

      const tasks: Array<Promise<void>> = [];
      const runProvider = (
        platform: PlatformId,
        fn: () => Promise<GeoPost[]>,
        noteWhenSkipped?: string
      ) => {
        if (!activeSet.has(platform)) return;
        if (noteWhenSkipped) {
          providers.push({ platform, ok: false, fetched: 0, latencyMs: 0, note: noteWhenSkipped });
          return;
        }
        const t0 = Date.now();
        tasks.push(
          fn()
            .then(items => {
              cache.upsertMany(items);
              providers.push({
                platform,
                ok: true,
                fetched: items.length,
                latencyMs: Date.now() - t0,
              });
            })
            .catch((err: any) => {
              providers.push({
                platform,
                ok: false,
                fetched: 0,
                latencyMs: Date.now() - t0,
                note: err?.message || 'Upstream timeout',
              });
            })
        );
      };

      runProvider('inaturalist', () => fetchInaturalistNear(lat, lon, radiusKm, q));
      runProvider('wikimedia', () => fetchWikimediaNear(lat, lon, radiusKm));
      runProvider('bluesky', () => fetchBlueskyForArea(area, radiusKm, q));
      runProvider('reddit', () => fetchRedditForArea(area, radiusKm, q));
      runProvider('mastodon', () => fetchMastodonForArea(area, radiusKm, q));
      runProvider(
        'x',
        () => fetchXLiveNear(area, radiusKm, xBearer, q),
        xBearer ? undefined : 'Connect X token or import tweets.js/JSON/CSV'
      );

      await Promise.all(tasks);
      cache.markSwept(sweepKey, providers);
    } else if (!disableExternal) {
      providers.push(...cache.getSweepProviders(sweepKey));
    }

    const posts = cache.query({
      lat,
      lon,
      radiusKm,
      platforms,
      exactOnly,
      q,
      fromIso,
      toIso,
    });

    const exactGpsCount = posts.filter(p => p.precision === 'exact_gps').length;

    const payload: SweepResponse = {
      area,
      radiusKm,
      totalInCone: posts.length,
      exactGpsCount,
      posts,
      providers,
      sweptAt: new Date().toISOString(),
    };

    res.json(payload);
  });

  app.get('/api/user-trail', async (req, res) => {
    const rawHandle = String(req.query.handle || '').trim();
    if (!rawHandle) {
      res.status(400).json({ error: 'Missing handle query parameter' });
      return;
    }

    const platformParam = String(req.query.platform || '').trim().toLowerCase();
    const platform = ALL_PLATFORMS.includes(platformParam as PlatformId)
      ? (platformParam as PlatformId)
      : undefined;

    if (!disableExternal) {
      const tasks: Array<Promise<GeoPost[]>> = [];
      if (!platform || platform === 'inaturalist') {
        tasks.push(fetchInaturalistUserTrail(rawHandle));
      }
      if (!platform || platform === 'wikimedia') {
        tasks.push(fetchWikimediaUserTrail(rawHandle));
      }
      if (!platform || platform === 'bluesky') {
        tasks.push(fetchBlueskyUserTrail(rawHandle));
      }
      const batches = await Promise.all(tasks);
      for (const b of batches) {
        cache.upsertMany(b);
      }
    }

    const stops = cache.getByAuthor(rawHandle, platform);
    let totalDistanceKm = 0;
    for (let i = 1; i < stops.length; i++) {
      totalDistanceKm += haversineKm(
        stops[i - 1].lat,
        stops[i - 1].lon,
        stops[i].lat,
        stops[i].lon
      );
    }

    const first = stops[0];
    const clean = normalizeHandle(rawHandle);
    const response: UserTrailResponse = {
      handle: first?.authorHandle || `@${clean}`,
      platform: first?.platform || platform,
      authorName: first?.authorName || clean,
      authorAvatar: first?.authorAvatar,
      authorProfileUrl: first?.authorProfileUrl,
      stops,
      totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    };

    res.json(response);
  });

  app.post('/api/import', (req, res) => {
    const rawContent = String(req.body?.rawContent || '');
    const defaultHandle = String(req.body?.defaultHandle || 'x_archive_user').trim();
    if (!rawContent.trim()) {
      res.status(400).json({ error: 'Empty archive payload' });
      return;
    }

    const parsed = parseImportedSocialArchive(rawContent, defaultHandle);
    if (parsed.length === 0) {
      res.status(422).json({
        error:
          'No geolocated posts found in file. Ensure tweets/rows include GPS coordinates or bounding boxes.',
      });
      return;
    }

    cache.upsertMany(parsed);

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const p of parsed) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }

    res.status(201).json({
      importedCount: parsed.length,
      center: {
        lat: Number(((minLat + maxLat) / 2).toFixed(5)),
        lon: Number(((minLon + maxLon) / 2).toFixed(5)),
      },
      bounds: [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      posts: parsed.slice(0, 250),
    });
  });

  app.delete('/api/cache', (_req, res) => {
    cache.clear();
    res.json({ cleared: true, cachedSignals: 0 });
  });

  const publicDir = path.resolve(process.cwd(), 'public');
  const distDir = path.resolve(process.cwd(), 'dist');

  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
        return;
      }
      next();
    });
  }

  return app;
}
