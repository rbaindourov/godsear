import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { EphemeralGeoCache, haversineKm } from '../memoryCache.js';
import { parseImportedSocialArchive } from '../../src/utils/archiveParser.js';
import type { GeoPost } from '../types.js';

describe('EphemeralGeoCache', () => {
  const samplePosts: GeoPost[] = [
    {
      id: 'x:1001',
      platform: 'x',
      authorHandle: '@alice_la',
      authorName: 'Alice',
      authorProfileUrl: 'https://x.com/alice_la',
      text: 'Coffee on Spring St in DTLA',
      mediaUrls: [],
      permalink: 'https://x.com/alice_la/status/1001',
      createdAt: '2026-11-14T06:00:00.000Z',
      lat: 34.0488,
      lon: -118.2501,
      precision: 'exact_gps',
      placeLabel: 'Spring St, Downtown Los Angeles',
    },
    {
      id: 'x:1002',
      platform: 'x',
      authorHandle: '@alice_la',
      authorName: 'Alice',
      authorProfileUrl: 'https://x.com/alice_la',
      text: 'Walking past Grand Central Market',
      mediaUrls: [],
      permalink: 'https://x.com/alice_la/status/1002',
      createdAt: '2026-11-14T07:30:00.000Z',
      lat: 34.0506,
      lon: -118.2488,
      precision: 'exact_gps',
      placeLabel: 'Grand Central Market, Broadway',
    },
    {
      id: 'bluesky:2001',
      platform: 'bluesky',
      authorHandle: '@bob.bsky.social',
      authorName: 'Bob',
      authorProfileUrl: 'https://bsky.app/profile/bob.bsky.social',
      text: 'Traffic backed up near Arts District',
      mediaUrls: [],
      permalink: 'https://bsky.app/profile/bob.bsky.social/post/2001',
      createdAt: '2026-11-14T08:00:00.000Z',
      lat: 34.0403,
      lon: -118.2351,
      precision: 'neighborhood',
      placeLabel: 'Arts District, Los Angeles',
    },
  ];

  it('deduplicates by permalink, filters by radius & exactOnly, and orders trails chronologically', () => {
    const cache = new EphemeralGeoCache(100);
    expect(cache.upsertMany(samplePosts)).toBe(3);
    // Duplicate permalink should update in place, not increase count
    expect(cache.upsertMany([{ ...samplePosts[0], id: 'x:dup-1001' }])).toBe(0);
    expect(cache.size()).toBe(3);

    const allIn5Km = cache.query({
      lat: 34.0522,
      lon: -118.2437,
      radiusKm: 5,
    });
    expect(allIn5Km).toHaveLength(3);
    // Sweep results are newest-first
    expect(allIn5Km[0].id).toBe('bluesky:2001');

    const exactOnly = cache.query({
      lat: 34.0522,
      lon: -118.2437,
      radiusKm: 5,
      exactOnly: true,
    });
    expect(exactOnly).toHaveLength(2);
    expect(exactOnly.every(p => p.precision === 'exact_gps')).toBe(true);

    // Author trail is oldest-first (1 -> 2)
    const trail = cache.getByAuthor('@alice_la');
    expect(trail).toHaveLength(2);
    expect(trail[0].id).toBe('x:1001');
    expect(trail[1].id).toBe('x:1002');
    expect(haversineKm(trail[0].lat, trail[0].lon, trail[1].lat, trail[1].lon)).toBeGreaterThan(0.1);
  });
});

describe('parseImportedSocialArchive', () => {
  it('parses X/Twitter window.YTD.tweet.part0 archive and drops unlocated tweets', () => {
    const rawTweetsJs = `window.YTD.tweet.part0 = [
      {
        "tweet": {
          "id_str": "189900112233",
          "full_text": "Sunset from Griffith Observatory terrace",
          "created_at": "Sat Nov 14 01:15:00 +0000 2026",
          "coordinates": { "type": "Point", "coordinates": [-118.3004, 34.1184] }
        }
      },
      {
        "tweet": {
          "id_str": "189900112234",
          "full_text": "Tweet with no coordinates should be ignored"
        }
      }
    ];`;

    const posts = parseImportedSocialArchive(rawTweetsJs, 'griffith_watcher');
    expect(posts).toHaveLength(1);
    expect(posts[0].authorHandle).toBe('@griffith_watcher');
    expect(posts[0].lat).toBeCloseTo(34.1184, 4);
    expect(posts[0].lon).toBeCloseTo(-118.3004, 4);
    expect(posts[0].precision).toBe('exact_gps');
    expect(posts[0].permalink).toBe('https://x.com/griffith_watcher/status/189900112233');
  });

  it('parses GeoJSON FeatureCollection and CSV geolocated rows', () => {
    const geojson = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-118.4962, 34.0094] },
          properties: {
            id: 'sm-pier-1',
            handle: 'pier_cam',
            text: 'Marine layer rolling past Santa Monica Pier',
            place: 'Santa Monica Pier',
          },
        },
      ],
    });
    const fromGeoJson = parseImportedSocialArchive(geojson);
    expect(fromGeoJson).toHaveLength(1);
    expect(fromGeoJson[0].placeLabel).toBe('Santa Monica Pier');

    const csv = [
      'lat,lon,handle,text,created_at,place',
      '34.0522,-118.2437,dtla_scout,"Sirens heading north on Broadway",2026-11-14T04:00:00Z,Civic Center',
    ].join('\n');
    const fromCsv = parseImportedSocialArchive(csv);
    expect(fromCsv).toHaveLength(1);
    expect(fromCsv[0].authorHandle).toBe('@dtla_scout');
    expect(fromCsv[0].text).toBe('Sirens heading north on Broadway');
  });
});

describe('GodsEar Express API (isolated ephemeral cache)', () => {
  it('supports health check, archive import, spatial sweep, user trail, and RAM wipe', async () => {
    const cache = new EphemeralGeoCache(500);
    const app = createApp({ cache, disableExternalFetch: true });

    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.storage).toBe('ephemeral-in-memory');

    const importPayload = JSON.stringify([
      {
        id: '9001',
        username: 'la_runner',
        text: 'Starting run at Union Station',
        created_at: '2026-11-14T05:00:00Z',
        lat: 34.0562,
        lon: -118.2365,
        placeLabel: 'Los Angeles Union Station',
      },
      {
        id: '9002',
        username: 'la_runner',
        text: 'Reached Echo Park Lake boathouse',
        created_at: '2026-11-14T05:35:00Z',
        lat: 34.0727,
        lon: -118.2606,
        placeLabel: 'Echo Park Lake',
      },
    ]);

    const importRes = await request(app)
      .post('/api/import')
      .send({ rawContent: importPayload, defaultHandle: 'la_runner' });
    expect(importRes.status).toBe(201);
    expect(importRes.body.importedCount).toBe(2);

    const sweepRes = await request(app).get(
      '/api/sweep?lat=34.0522&lon=-118.2437&radiusKm=5'
    );
    expect(sweepRes.status).toBe(200);
    expect(sweepRes.body.totalInCone).toBe(2);
    expect(sweepRes.body.exactGpsCount).toBe(2);

    const trailRes = await request(app).get('/api/user-trail?handle=@la_runner');
    expect(trailRes.status).toBe(200);
    expect(trailRes.body.stops).toHaveLength(2);
    expect(trailRes.body.stops[0].placeLabel).toBe('Los Angeles Union Station');
    expect(trailRes.body.stops[1].placeLabel).toBe('Echo Park Lake');
    expect(trailRes.body.totalDistanceKm).toBeGreaterThan(2);

    const delRes = await request(app).delete('/api/cache');
    expect(delRes.status).toBe(200);
    expect(delRes.body.cachedSignals).toBe(0);

    // Subpath /api/godsear mount parity (robertscreations.com/godsear)
    const subHealth = await request(app).get('/api/godsear/health');
    expect(subHealth.status).toBe(200);
    expect(subHealth.body.service).toBe('godsear');

    // Negative controls: unlocated import must return 422, invalid coords must return 400
    const unlocatedRes = await request(app)
      .post('/api/godsear/import')
      .send({ rawContent: JSON.stringify([{ id: '1', text: 'No GPS here' }]) });
    expect(unlocatedRes.status).toBe(422);

    const badSweepRes = await request(app).get('/api/godsear/sweep?lat=999&lon=-118');
    expect(badSweepRes.status).toBe(400);
  });
});
