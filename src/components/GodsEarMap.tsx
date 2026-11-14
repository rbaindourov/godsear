import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoPost, PlatformId, UserTrailResponse } from '../../server/types';

export type MapStyleMode = 'streets3d' | 'satellite';

export const PLATFORM_META: Record<
  PlatformId,
  { label: string; short: string; color: string }
> = {
  x: { label: 'X / Twitter', short: 'X', color: '#00f2fe' },
  bluesky: { label: 'Bluesky', short: 'BSKY', color: '#38bdf8' },
  reddit: { label: 'Reddit', short: 'REDDIT', color: '#fb923c' },
  mastodon: { label: 'Mastodon', short: 'MASTO', color: '#c084fc' },
  inaturalist: { label: 'Field GPS', short: 'GPS', color: '#34d399' },
  wikimedia: { label: 'Commons EXIF', short: 'EXIF', color: '#fbbf24' },
};

interface GodsEarMapProps {
  center: { lat: number; lon: number };
  radiusKm: number;
  posts: GeoPost[];
  selectedPostId: string | null;
  activeTrail: UserTrailResponse | null;
  styleMode: MapStyleMode;
  flyRequest: {
    lat: number;
    lon: number;
    zoom?: number;
    pitch?: number;
    seq: number;
  } | null;
  globeViewSeq: number;
  onSweepLocation: (lat: number, lon: number) => void;
  onSelectPost: (post: GeoPost | null) => void;
  onTrackAuthor: (handle: string, platform: PlatformId) => void;
  onOpenMedia: (url: string, post: GeoPost) => void;
}

interface PinCluster {
  key: string;
  lat: number;
  lon: number;
  isExact: boolean;
  primaryPlatform: PlatformId;
  posts: GeoPost[];
}

function createGeodesicCirclePolygon(
  lat: number,
  lon: number,
  radiusKm: number,
  steps = 72
): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: [number, number][] = [];
  const earthRadiusKm = 6371;
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const angDist = radiusKm / earthRadiusKm;

  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const sinLat2 =
      Math.sin(latRad) * Math.cos(angDist) +
      Math.cos(latRad) * Math.sin(angDist) * Math.cos(bearing);
    const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
    const lon2 =
      lonRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angDist) * Math.cos(latRad),
        Math.cos(angDist) - Math.sin(latRad) * Math.sin(lat2)
      );
    coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [coords],
    },
  };
}

export function GodsEarMap({
  center,
  radiusKm,
  posts,
  selectedPostId,
  activeTrail,
  styleMode,
  flyRequest,
  globeViewSeq,
  onSweepLocation,
  onSelectPost,
  onTrackAuthor,
  onOpenMedia,
}: GodsEarMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const trailMarkersRef = useRef<maplibregl.Marker[]>([]);
  const centerMarkerRef = useRef<maplibregl.Marker | null>(null);
  const styleLoadedRef = useRef(false);

  const [activeClusterKey, setActiveClusterKey] = useState<string | null>(null);
  const [clusterSlideIdx, setClusterSlideIdx] = useState(0);
  const [mapZoom, setMapZoom] = useState<number>(14.3);
  const [cursorCoords, setCursorCoords] = useState<{ lat: number; lon: number; zoom: number }>({
    lat: center.lat,
    lon: center.lon,
    zoom: 14.3,
  });

  // Zoom-aware spatial clustering (zero fake coordinate jitter; clean regional beacon on Globe view)
  const clusters = useMemo<PinCluster[]>(() => {
    const gridDeg =
      mapZoom < 5.5
        ? 1.5
        : mapZoom < 9
          ? 0.12
          : mapZoom < 12.5
            ? 0.012
            : 0.00018;

    const grouped = new Map<string, PinCluster>();
    for (const p of posts) {
      const gx = Math.round(p.lat / gridDeg);
      const gy = Math.round(p.lon / gridDeg);
      const key = `${gx}:${gy}`;
      const existing = grouped.get(key);
      if (existing) {
        const n = existing.posts.length;
        existing.lat = (existing.lat * n + p.lat) / (n + 1);
        existing.lon = (existing.lon * n + p.lon) / (n + 1);
        existing.posts.push(p);
        if (p.precision === 'exact_gps' && !existing.isExact) {
          existing.isExact = true;
          existing.primaryPlatform = p.platform;
        }
      } else {
        grouped.set(key, {
          key,
          lat: p.lat,
          lon: p.lon,
          isExact: p.precision === 'exact_gps',
          primaryPlatform: p.platform,
          posts: [p],
        });
      }
    }
    return Array.from(grouped.values());
  }, [posts, mapZoom]);

  // Clear stale cluster key whenever activeTrail changes
  useEffect(() => {
    setActiveClusterKey(null);
    setClusterSlideIdx(0);
  }, [activeTrail]);

  const activeCluster = useMemo<PinCluster | null>(() => {
    if (activeTrail && activeTrail.stops.length > 0) {
      if (!selectedPostId) return null;
      const stop = activeTrail.stops.find(s => s.id === selectedPostId);
      if (!stop) return null;
      return {
        key: `trail:${stop.id}`,
        lat: stop.lat,
        lon: stop.lon,
        isExact: stop.precision === 'exact_gps',
        primaryPlatform: stop.platform,
        posts: [stop],
      };
    }
    if (activeClusterKey) {
      const found = clusters.find(c => c.key === activeClusterKey);
      if (found) return found;
    }
    if (selectedPostId) {
      return clusters.find(c => c.posts.some(p => p.id === selectedPostId)) || null;
    }
    return null;
  }, [clusters, activeClusterKey, selectedPostId, activeTrail]);

  // Keep latest callback ref for map click
  const sweepCallbackRef = useRef(onSweepLocation);
  sweepCallbackRef.current = onSweepLocation;

  // Initialize MapLibre GL v5 with Globe projection + 3D extruded buildings + Satellite hybrid layer
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [center.lon, center.lat],
      zoom: 14.3,
      pitch: 55,
      bearing: -16,
      maxPitch: 75,
      attributionControl: false,
    });

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }),
      'bottom-left'
    );
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

    map.on('style.load', () => {
      styleLoadedRef.current = true;

      try {
        map.setProjection({ type: 'globe' });
      } catch {
        // Fallback gracefully if environment lacks globe shader
      }

      try {
        map.setSky({
          'sky-color': '#050912',
          'horizon-color': '#0d1b30',
          'fog-color': '#090d16',
          'sky-horizon-blend': 0.5,
          'horizon-fog-blend': 0.6,
          'fog-ground-blend': 0.3,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.85, 7, 0.35, 11, 0],
        } as any);
      } catch {
        // Ignore if sky spec differs
      }

      // Insert ESRI World Imagery Satellite raster layer underneath labels & roads
      if (!map.getSource('esri-satellite')) {
        map.addSource('esri-satellite', {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Esri, Maxar, Earthstar Geographics',
        });

        const styleLayers = map.getStyle().layers || [];
        const firstRoadOrLabel = styleLayers.find(
          l =>
            l.type === 'symbol' ||
            l.id.includes('road') ||
            l.id.includes('highway') ||
            l.id.includes('building')
        );

        map.addLayer(
          {
            id: 'esri-satellite-layer',
            type: 'raster',
            source: 'esri-satellite',
            layout: {
              visibility: styleMode === 'satellite' ? 'visible' : 'none',
            },
            paint: {
              'raster-opacity': 0.86,
              'raster-contrast': 0.08,
            },
          },
          firstRoadOrLabel?.id
        );
      }

      // Add 3D Extruded Buildings layer
      if (map.getSource('openmaptiles') && !map.getLayer('godsear-3d-buildings')) {
        const styleLayers = map.getStyle().layers || [];
        const firstSymbolLayerId = styleLayers.find(l => l.type === 'symbol')?.id;

        map.addLayer(
          {
            id: 'godsear-3d-buildings',
            source: 'openmaptiles',
            'source-layer': 'building',
            type: 'fill-extrusion',
            minzoom: 13,
            paint: {
              'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['coalesce', ['get', 'render_height'], 12],
                0,
                '#111c2d',
                60,
                '#172a45',
                180,
                '#1e3a5f',
              ],
              'fill-extrusion-height': [
                'interpolate',
                ['linear'],
                ['zoom'],
                13,
                0,
                13.6,
                ['coalesce', ['get', 'render_height'], 12],
              ],
              'fill-extrusion-base': [
                'interpolate',
                ['linear'],
                ['zoom'],
                13,
                0,
                13.6,
                ['coalesce', ['get', 'render_min_height'], 0],
              ],
              'fill-extrusion-opacity': 0.78,
            },
          },
          firstSymbolLayerId
        );
      }

      // Add Geodesic Sweep Radius Cone source & layers
      if (!map.getSource('godsear-cone')) {
        map.addSource('godsear-cone', {
          type: 'geojson',
          data: createGeodesicCirclePolygon(center.lat, center.lon, radiusKm),
        });

        map.addLayer({
          id: 'godsear-cone-fill',
          type: 'fill',
          source: 'godsear-cone',
          paint: {
            'fill-color': '#00f2fe',
            'fill-opacity': 0.045,
          },
        });

        map.addLayer({
          id: 'godsear-cone-stroke',
          type: 'line',
          source: 'godsear-cone',
          paint: {
            'line-color': '#00f2fe',
            'line-width': 1.8,
            'line-dasharray': [3, 2],
            'line-opacity': 0.75,
          },
        });
      }

      // Add @user Movement Trail source & line layer
      if (!map.getSource('godsear-trail')) {
        map.addSource('godsear-trail', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: 'godsear-trail-glow',
          type: 'line',
          source: 'godsear-trail',
          paint: {
            'line-color': '#00f2fe',
            'line-width': 7,
            'line-opacity': 0.25,
            'line-blur': 3,
          },
        });

        map.addLayer({
          id: 'godsear-trail-line',
          type: 'line',
          source: 'godsear-trail',
          paint: {
            'line-color': '#00f2fe',
            'line-width': 2.6,
            'line-dasharray': [2, 1.5],
          },
        });
      }
    });

    map.on('mousemove', e => {
      setCursorCoords({
        lat: e.lngLat.lat,
        lon: e.lngLat.lng,
        zoom: map.getZoom(),
      });
    });

    map.on('zoomend', () => {
      const c = map.getCenter();
      const z = map.getZoom();
      setMapZoom(z);
      setCursorCoords({
        lat: c.lat,
        lon: c.lng,
        zoom: z,
      });
    });

    // Click anywhere on street/globe (outside pin markers) to sweep that spot
    map.on('click', e => {
      const targetEl = e.originalEvent?.target as HTMLElement | null;
      if (targetEl?.closest('.godsear-pin') || targetEl?.closest('.godsear-trail-stop')) {
        return;
      }
      setActiveClusterKey(null);
      sweepCallbackRef.current(e.lngLat.lat, e.lngLat.lng);
    });

    mapRef.current = map;

    return () => {
      styleLoadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Toggle Satellite vs 3D Dark Vector Streets
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleLoadedRef.current) return;
    if (map.getLayer('esri-satellite-layer')) {
      map.setLayoutProperty(
        'esri-satellite-layer',
        'visibility',
        styleMode === 'satellite' ? 'visible' : 'none'
      );
    }
    if (map.getLayer('godsear-3d-buildings')) {
      map.setPaintProperty(
        'godsear-3d-buildings',
        'fill-extrusion-opacity',
        styleMode === 'satellite' ? 0.42 : 0.78
      );
    }
  }, [styleMode]);

  // Update Sweep Radius Cone & Center Reticle Marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const updateCone = () => {
      const src = map.getSource('godsear-cone') as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(createGeodesicCirclePolygon(center.lat, center.lon, radiusKm));
      }
    };

    if (styleLoadedRef.current) {
      updateCone();
    } else {
      map.once('style.load', updateCone);
    }

    if (centerMarkerRef.current) {
      centerMarkerRef.current.setLngLat([center.lon, center.lat]);
    } else {
      const wrap = document.createElement('div');
      const el = document.createElement('div');
      el.className = 'godsear-center-reticle';
      el.setAttribute('aria-hidden', 'true');
      wrap.appendChild(el);
      centerMarkerRef.current = new maplibregl.Marker({ element: wrap, anchor: 'center' })
        .setLngLat([center.lon, center.lat])
        .addTo(map);
    }
  }, [center.lat, center.lon, radiusKm]);

  // Fly camera on explicit flyRequest
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyRequest) return;
    map.flyTo({
      center: [flyRequest.lon, flyRequest.lat],
      zoom: flyRequest.zoom ?? 15.8,
      pitch: flyRequest.pitch ?? 56,
      speed: 1.45,
      essential: true,
    });
  }, [flyRequest]);

  // Zoom out to 3D Orbital Globe on globeViewSeq
  useEffect(() => {
    const map = mapRef.current;
    if (!map || globeViewSeq === 0) return;
    setActiveClusterKey(null);
    map.flyTo({
      center: [center.lon, Math.max(-25, Math.min(35, center.lat))],
      zoom: 2.15,
      pitch: 0,
      bearing: 0,
      speed: 1.35,
      essential: true,
    });
  }, [globeViewSeq]);

  // Render Post Pin Markers (wrap inner button inside untouched Marker host div so MapLibre owns position & transform)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const m of markersRef.current) {
      m.remove();
    }
    markersRef.current = [];

    if (activeTrail && activeTrail.stops.length > 0) {
      return;
    }

    for (const cluster of clusters) {
      const meta = PLATFORM_META[cluster.primaryPlatform];
      const hasSelected = cluster.posts.some(p => p.id === selectedPostId);
      const leadPost = cluster.posts[0];

      const wrap = document.createElement('div');
      const el = document.createElement('button');
      el.type = 'button';
      el.className = [
        'godsear-pin',
        cluster.isExact ? 'pin-exact' : 'pin-place',
        hasSelected ? 'pin-selected' : '',
      ]
        .filter(Boolean)
        .join(' ');
      el.style.setProperty('--pin-color', meta.color);
      el.title = `${leadPost.authorHandle} · ${leadPost.placeLabel} (${
        cluster.isExact ? 'Exact GPS' : 'Geocoded Place'
      })`;

      if (cluster.isExact && leadPost.mediaUrls[0] && cluster.posts.length === 1) {
        const img = document.createElement('img');
        img.src = leadPost.mediaUrls[0];
        img.alt = '';
        img.loading = 'lazy';
        img.className = 'pin-thumb';
        el.appendChild(img);
      } else {
        const core = document.createElement('span');
        core.className = 'pin-core';
        el.appendChild(core);
      }

      if (cluster.posts.length > 1) {
        const countBadge = document.createElement('span');
        countBadge.className = 'pin-count';
        countBadge.textContent = String(cluster.posts.length);
        el.appendChild(countBadge);
      }

      el.addEventListener('click', ev => {
        ev.stopPropagation();
        setActiveClusterKey(cluster.key);
        setClusterSlideIdx(0);
        onSelectPost(cluster.posts[0]);
      });

      wrap.appendChild(el);
      const marker = new maplibregl.Marker({ element: wrap, anchor: 'center' })
        .setLngLat([cluster.lon, cluster.lat])
        .addTo(map);
      markersRef.current.push(marker);
    }
  }, [clusters, selectedPostId, activeTrail, onSelectPost]);

  // Render @user Chronological Movement Trail Line + Stop Badges
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const tm of trailMarkersRef.current) {
      tm.remove();
    }
    trailMarkersRef.current = [];

    const updateTrailSource = (data: GeoJSON.FeatureCollection) => {
      const src = map.getSource('godsear-trail') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
    };

    if (!activeTrail || activeTrail.stops.length === 0) {
      if (styleLoadedRef.current) {
        updateTrailSource({ type: 'FeatureCollection', features: [] });
      }
      return;
    }

    const stops = activeTrail.stops;
    const lineFeature: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: stops.map(s => [s.lon, s.lat]),
      },
    };

    const collection: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: stops.length >= 2 ? [lineFeature] : [],
    };

    if (styleLoadedRef.current) {
      updateTrailSource(collection);
    } else {
      map.once('style.load', () => updateTrailSource(collection));
    }

    const bounds = new maplibregl.LngLatBounds();
    stops.forEach((stop, idx) => {
      bounds.extend([stop.lon, stop.lat]);
      const wrap = document.createElement('div');
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'godsear-trail-stop';
      badge.textContent = String(idx + 1);
      badge.title = `Stop #${idx + 1}: ${stop.placeLabel} (${new Date(
        stop.createdAt
      ).toLocaleString()})`;
      badge.addEventListener('click', ev => {
        ev.stopPropagation();
        onSelectPost(stop);
      });
      wrap.appendChild(badge);
      const m = new maplibregl.Marker({ element: wrap, anchor: 'center' })
        .setLngLat([stop.lon, stop.lat])
        .addTo(map);
      trailMarkersRef.current.push(m);
    });

    if (stops.length >= 2) {
      map.fitBounds(bounds, {
        padding: { top: 110, bottom: 130, left: 80, right: 430 },
        maxZoom: 15.5,
        pitch: 48,
        duration: 1200,
      });
    } else if (stops.length === 1) {
      map.flyTo({
        center: [stops[0].lon, stops[0].lat],
        zoom: 15.8,
        pitch: 55,
      });
    }
  }, [activeTrail, onSelectPost]);

  const inspectedPost = activeCluster
    ? activeCluster.posts[Math.min(clusterSlideIdx, activeCluster.posts.length - 1)]
    : null;

  return (
    <div className="godsear-map-stage">
      <div
        ref={containerRef}
        className="godsear-map-canvas"
        role="application"
        aria-label="GodsEar 3D Globe-to-Street Geo-Social Map"
      />

      {/* Bottom-left live telemetry coordinate readout */}
      <div className="hud-coord-strip" aria-live="off">
        <span>
          CURSOR: {cursorCoords.lat.toFixed(4)}°, {cursorCoords.lon.toFixed(4)}°
        </span>
        <span>ZOOM: {cursorCoords.zoom.toFixed(1)}x</span>
        <span className="legend-item">
          <i className="legend-exact" /> EXACT GPS / EXIF
        </span>
        <span className="legend-item">
          <i className="legend-place" /> VENUE / PLACE
        </span>
      </div>

      {/* Floating Street-Level Intercept Card when a pin/cluster is selected */}
      {activeCluster && inspectedPost && (
        <aside className="hud-pin-inspector" aria-label="Selected map signal">
          <div className="pin-insp-top">
            <div className="pin-insp-badges">
              <span
                className="platform-chip"
                style={{
                  borderColor: PLATFORM_META[inspectedPost.platform].color,
                  color: PLATFORM_META[inspectedPost.platform].color,
                }}
              >
                {PLATFORM_META[inspectedPost.platform].label}
              </span>
              <span
                className={`precision-chip ${
                  inspectedPost.precision === 'exact_gps' ? 'exact' : 'place'
                }`}
              >
                {inspectedPost.precision === 'exact_gps'
                  ? 'EXACT GPS'
                  : inspectedPost.precision.toUpperCase()}
              </span>
            </div>

            <div className="pin-insp-pager">
              {activeCluster.posts.length > 1 && (
                <>
                  <button
                    type="button"
                    className="pager-btn"
                    onClick={() => {
                      const next =
                        (clusterSlideIdx - 1 + activeCluster.posts.length) %
                        activeCluster.posts.length;
                      setClusterSlideIdx(next);
                      onSelectPost(activeCluster.posts[next]);
                    }}
                    aria-label="Previous signal at this location"
                  >
                    ◀
                  </button>
                  <span>
                    {clusterSlideIdx + 1}/{activeCluster.posts.length}
                  </span>
                  <button
                    type="button"
                    className="pager-btn"
                    onClick={() => {
                      const next = (clusterSlideIdx + 1) % activeCluster.posts.length;
                      setClusterSlideIdx(next);
                      onSelectPost(activeCluster.posts[next]);
                    }}
                    aria-label="Next signal at this location"
                  >
                    ▶
                  </button>
                </>
              )}
              <button
                type="button"
                className="insp-dismiss"
                onClick={() => {
                  setActiveClusterKey(null);
                  onSelectPost(null);
                }}
                aria-label="Close signal card"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="pin-insp-author">
            {inspectedPost.authorAvatar ? (
              <img
                src={inspectedPost.authorAvatar}
                alt=""
                width={34}
                height={34}
                className="author-avatar"
                loading="lazy"
              />
            ) : (
              <div className="author-avatar-fallback">
                {inspectedPost.authorName.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              <strong>{inspectedPost.authorName}</strong>
              <span className="author-handle">{inspectedPost.authorHandle}</span>
            </div>
          </div>

          <p className="pin-insp-text">{inspectedPost.text}</p>

          {inspectedPost.mediaUrls.length > 0 && (
            <div className="pin-insp-media">
              {inspectedPost.mediaUrls.slice(0, 2).map(url => (
                <button
                  key={url}
                  type="button"
                  className="media-thumb-btn"
                  onClick={() => onOpenMedia(url, inspectedPost)}
                >
                  <img
                    src={url}
                    alt="Geolocated post attachment"
                    width={260}
                    height={146}
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}

          <div className="pin-insp-loc">
            <span>📍 {inspectedPost.placeLabel}</span>
            <span>
              {inspectedPost.lat.toFixed(5)}°, {inspectedPost.lon.toFixed(5)}°
              {inspectedPost.accuracyMeters ? ` (±${inspectedPost.accuracyMeters}m)` : ''}
            </span>
            <span>{new Date(inspectedPost.createdAt).toLocaleString()}</span>
          </div>

          <div className="pin-insp-actions">
            <button
              type="button"
              className="action-btn-cyan"
              onClick={() =>
                onTrackAuthor(inspectedPost.authorHandle, inspectedPost.platform)
              }
            >
              Track {inspectedPost.authorHandle} Trail
            </button>
            <a
              href={inspectedPost.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="action-link-outline"
            >
              Original Post ↗
            </a>
          </div>
        </aside>
      )}
    </div>
  );
}
