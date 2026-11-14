import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  GeoPost,
  PlatformId,
  ProviderStatus,
  SweepResponse,
  UserTrailResponse,
} from '../server/types';
import { GodsEarMap, type MapStyleMode } from './components/GodsEarMap';
import { TopCommandBar } from './components/TopCommandBar';
import { InterceptDrawer } from './components/InterceptDrawer';
import { TimeScrubberBar } from './components/TimeScrubberBar';
import { ImportAndXModal } from './components/ImportAndXModal';
import './style.css';

// Default cold-start sector: 3D Street-Level Downtown / Central Los Angeles
const INITIAL_CENTER = { lat: 34.0522, lon: -118.2437 };
const INITIAL_RADIUS_KM = 5;

function App() {
  const [center, setCenter] = useState(INITIAL_CENTER);
  const [radiusKm, setRadiusKm] = useState<number>(INITIAL_RADIUS_KM);
  const [areaLabel, setAreaLabel] = useState<string>('Los Angeles, California');
  const [styleMode, setStyleMode] = useState<MapStyleMode>('streets3d');
  const [exactOnly, setExactOnly] = useState<boolean>(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<PlatformId[]>([]);
  const [keywordFilter, setKeywordFilter] = useState<string>('');
  const [serverQuery, setServerQuery] = useState<string>('');

  const [rawPosts, setRawPosts] = useState<GeoPost[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [sweeping, setSweeping] = useState<boolean>(true);
  const [toastMsg, setToastMsg] = useState<string>('');

  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [activeTrail, setActiveTrail] = useState<UserTrailResponse | null>(null);
  const [trailLoading, setTrailLoading] = useState<boolean>(false);

  const [startPct, setStartPct] = useState<number>(0);
  const [endPct, setEndPct] = useState<number>(100);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const [flyRequest, setFlyRequest] = useState<{
    lat: number;
    lon: number;
    zoom?: number;
    pitch?: number;
    seq: number;
  } | null>(null);
  const [globeViewSeq, setGlobeViewSeq] = useState<number>(0);

  const [importOpen, setImportOpen] = useState<boolean>(false);
  const [xBearerToken, setXBearerToken] = useState<string>('');
  const [lightboxMedia, setLightboxMedia] = useState<{ url: string; post: GeoPost } | null>(null);
  const lightboxRef = useRef<HTMLDialogElement>(null);
  const lightboxTitleId = useId();

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
  }, []);

  useEffect(() => {
    if (!toastMsg) return;
    const t = window.setTimeout(() => setToastMsg(''), 4200);
    return () => window.clearTimeout(t);
  }, [toastMsg]);

  // Execute spatial sweep against backend
  const executeSweep = useCallback(
    async (opts: {
      lat: number;
      lon: number;
      radiusKm: number;
      q?: string;
      force?: boolean;
    }) => {
      setSweeping(true);
      try {
        const params = new URLSearchParams({
          lat: String(opts.lat),
          lon: String(opts.lon),
          radiusKm: String(opts.radiusKm),
        });
        if (opts.q) params.set('q', opts.q);
        if (opts.force) params.set('force', 'true');

        const headers: Record<string, string> = { Accept: 'application/json' };
        if (xBearerToken) {
          headers['x-twitter-bearer'] = xBearerToken;
        }

        const res = await fetch(`/api/sweep?${params.toString()}`, { headers });
        if (!res.ok) throw new Error(`Sweep HTTP ${res.status}`);
        const data = (await res.json()) as SweepResponse;

        setRawPosts(data.posts || []);
        setAreaLabel(data.area?.displayLabel || `${opts.lat.toFixed(4)}°, ${opts.lon.toFixed(4)}°`);
        if (data.providers && data.providers.length > 0) {
          setProviders(data.providers);
        }
        setStartPct(0);
        setEndPct(100);
      } catch {
        showToast('Could not complete live sweep — check local server connection.');
      } finally {
        setSweeping(false);
      }
    },
    [xBearerToken, showToast]
  );

  // Trigger sweep whenever center, radiusKm, serverQuery, or xBearerToken changes
  useEffect(() => {
    executeSweep({
      lat: center.lat,
      lon: center.lon,
      radiusKm,
      q: serverQuery,
    });
  }, [center.lat, center.lon, radiusKm, serverQuery, executeSweep]);

  // Compute per-platform counts across active sweep cone
  const platformCounts = useMemo(() => {
    const counts: Record<PlatformId, number> = {
      x: 0,
      bluesky: 0,
      reddit: 0,
      mastodon: 0,
      inaturalist: 0,
      wikimedia: 0,
    };
    for (const p of rawPosts) {
      counts[p.platform] = (counts[p.platform] || 0) + 1;
    }
    return counts;
  }, [rawPosts]);

  // Apply instant client-side platform, Exact-GPS, keyword, and time-scrubber filters
  const baseFilteredPosts = useMemo(() => {
    const kw = keywordFilter.trim().toLowerCase();
    return rawPosts.filter(p => {
      if (exactOnly && p.precision !== 'exact_gps') return false;
      if (selectedPlatforms.length > 0 && !selectedPlatforms.includes(p.platform)) return false;
      if (kw) {
        const hay = `${p.authorHandle} ${p.authorName} ${p.text} ${p.placeLabel}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [rawPosts, exactOnly, selectedPlatforms, keywordFilter]);

  const visiblePosts = useMemo(() => {
    if (startPct <= 0 && endPct >= 100) return baseFilteredPosts;
    if (baseFilteredPosts.length === 0) return baseFilteredPosts;

    // baseFilteredPosts is sorted newest-first; reverse to oldest-first for quantile windowing
    const chronological = [...baseFilteredPosts].reverse();
    const n = chronological.length;
    const startIdx = Math.min(n - 1, Math.max(0, Math.floor((startPct / 100) * (n - 1))));
    const endIdx = Math.min(n - 1, Math.max(startIdx, Math.ceil((endPct / 100) * (n - 1))));

    return chronological.slice(startIdx, endIdx + 1).reverse();
  }, [baseFilteredPosts, startPct, endPct]);

  const exactGpsCount = useMemo(
    () => visiblePosts.filter(p => p.precision === 'exact_gps').length,
    [visiblePosts]
  );

  // Track @handle movement trail
  const handleTrackAuthor = useCallback(
    async (handle: string, platform?: PlatformId) => {
      setTrailLoading(true);
      try {
        const params = new URLSearchParams({ handle });
        if (platform) params.set('platform', platform);
        const res = await fetch(`/api/user-trail?${params.toString()}`);
        if (!res.ok) throw new Error('Trail lookup failed');
        const data = (await res.json()) as UserTrailResponse;
        if (data.stops.length === 0) {
          showToast(`No geolocated stops found for ${handle}.`);
          setActiveTrail(null);
        } else {
          setActiveTrail(data);
          setSelectedPostId(data.stops[data.stops.length - 1].id);
        }
      } catch {
        showToast(`Could not load geolocated trail for ${handle}.`);
      } finally {
        setTrailLoading(false);
      }
    },
    [showToast]
  );

  // Unified search bar handler (place/street, coordinates, @handle, or keyword)
  const handleSearchSubmit = useCallback(
    async (rawQuery: string) => {
      const q = rawQuery.trim();
      if (!q) return;

      if (q.startsWith('@') || q.toLowerCase().startsWith('u/')) {
        await handleTrackAuthor(q);
        return;
      }

      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const geo = (await res.json()) as { lat: number; lon: number; label: string };
          setActiveTrail(null);
          setServerQuery('');
          setCenter({ lat: geo.lat, lon: geo.lon });
          setFlyRequest(prev => ({
            lat: geo.lat,
            lon: geo.lon,
            zoom: radiusKm <= 1 ? 16 : 14.3,
            pitch: 55,
            seq: (prev?.seq || 0) + 1,
          }));
          return;
        }
      } catch {
        // Fall back to keyword search inside current cone
      }

      setServerQuery(q);
      showToast(`Sweeping "${q}" inside ${areaLabel}`);
    },
    [handleTrackAuthor, radiusKm, areaLabel, showToast]
  );

  const handleSweepLocation = useCallback((lat: number, lon: number) => {
    setActiveTrail(null);
    setCenter({ lat, lon });
    setFlyRequest(prev => ({
      lat,
      lon,
      zoom: 14.8,
      pitch: 55,
      seq: (prev?.seq || 0) + 1,
    }));
  }, []);

  const handleSelectSector = useCallback((lat: number, lon: number, nextRadiusKm: number) => {
    setActiveTrail(null);
    setServerQuery('');
    setCenter({ lat, lon });
    setRadiusKm(nextRadiusKm);
    setFlyRequest(prev => ({
      lat,
      lon,
      zoom: nextRadiusKm <= 2 ? 15.2 : 14.2,
      pitch: 55,
      seq: (prev?.seq || 0) + 1,
    }));
  }, []);

  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation) {
      showToast('Browser geolocation is unavailable.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        setCenter({ lat: latitude, lon: longitude });
        setFlyRequest(prev => ({
          lat: latitude,
          lon: longitude,
          zoom: 15.4,
          pitch: 55,
          seq: (prev?.seq || 0) + 1,
        }));
      },
      () => {
        showToast('Location permission denied — click any street on the map instead.');
      },
      { enableHighAccuracy: true, timeout: 6000 }
    );
  }, [showToast]);

  const handleTogglePlatform = useCallback((platform: PlatformId | 'all') => {
    if (platform === 'all') {
      setSelectedPlatforms([]);
      return;
    }
    setSelectedPlatforms(prev =>
      prev.includes(platform) ? prev.filter(p => p !== platform) : [...prev, platform]
    );
  }, []);

  // Lightbox modal <dialog> lifecycle + Safari closedBy fallback
  useEffect(() => {
    const dlg = lightboxRef.current;
    if (!dlg) return;
    if (lightboxMedia && !dlg.open) {
      dlg.showModal();
    } else if (!lightboxMedia && dlg.open) {
      dlg.close();
    }
  }, [lightboxMedia]);

  useEffect(() => {
    const dlg = lightboxRef.current;
    if (!dlg) return;
    const onClose = () => setLightboxMedia(null);
    dlg.addEventListener('close', onClose);

    let fallbackClick: ((ev: MouseEvent) => void) | null = null;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      fallbackClick = (ev: MouseEvent) => {
        if (ev.target !== dlg) return;
        const rect = dlg.getBoundingClientRect();
        const inside =
          rect.top <= ev.clientY &&
          ev.clientY <= rect.top + rect.height &&
          rect.left <= ev.clientX &&
          ev.clientX <= rect.left + rect.width;
        if (!inside) dlg.close();
      };
      dlg.addEventListener('click', fallbackClick);
    }

    return () => {
      dlg.removeEventListener('close', onClose);
      if (fallbackClick) dlg.removeEventListener('click', fallbackClick);
    };
  }, []);

  return (
    <div className="godsear-shell">
      <GodsEarMap
        center={center}
        radiusKm={radiusKm}
        posts={visiblePosts}
        selectedPostId={selectedPostId}
        activeTrail={activeTrail}
        styleMode={styleMode}
        flyRequest={flyRequest}
        globeViewSeq={globeViewSeq}
        onSweepLocation={handleSweepLocation}
        onSelectPost={post => setSelectedPostId(post ? post.id : null)}
        onTrackAuthor={handleTrackAuthor}
        onOpenMedia={(url, post) => setLightboxMedia({ url, post })}
      />

      <TopCommandBar
        areaLabel={areaLabel}
        totalSignals={visiblePosts.length}
        exactGpsCount={exactGpsCount}
        radiusKm={radiusKm}
        exactOnly={exactOnly}
        styleMode={styleMode}
        sweeping={sweeping}
        selectedPlatforms={selectedPlatforms}
        platformCounts={platformCounts}
        xConnected={Boolean(xBearerToken)}
        onSearchSubmit={handleSearchSubmit}
        onSelectSector={handleSelectSector}
        onRadiusChange={km => setRadiusKm(km)}
        onToggleExactOnly={() => setExactOnly(v => !v)}
        onStyleModeChange={setStyleMode}
        onZoomGlobe={() => {
          setSelectedPostId(null);
          setActiveTrail(null);
          setGlobeViewSeq(s => s + 1);
        }}
        onLocateMe={handleLocateMe}
        onRefreshSweep={() =>
          executeSweep({ lat: center.lat, lon: center.lon, radiusKm, q: serverQuery, force: true })
        }
        onTogglePlatform={handleTogglePlatform}
        onOpenImportModal={() => setImportOpen(true)}
      />

      <InterceptDrawer
        posts={visiblePosts}
        selectedPostId={selectedPostId}
        activeTrail={activeTrail}
        trailLoading={trailLoading}
        sweeping={sweeping}
        areaLabel={areaLabel}
        radiusKm={radiusKm}
        keywordFilter={keywordFilter}
        providers={providers}
        onKeywordFilterChange={setKeywordFilter}
        onSelectPost={(post, shouldFly) => {
          setSelectedPostId(post.id);
          if (shouldFly) {
            setFlyRequest(prev => ({
              lat: post.lat,
              lon: post.lon,
              zoom: post.precision === 'exact_gps' ? 16.6 : 15.2,
              pitch: 58,
              seq: (prev?.seq || 0) + 1,
            }));
          }
        }}
        onTrackAuthor={handleTrackAuthor}
        onClearTrail={() => setActiveTrail(null)}
        onOpenMedia={(url, post) => setLightboxMedia({ url, post })}
      />

      <TimeScrubberBar
        allPosts={baseFilteredPosts}
        startPct={startPct}
        endPct={endPct}
        isPlaying={isPlaying}
        onRangePctChange={(s, e) => {
          setStartPct(s);
          setEndPct(e);
        }}
        onTogglePlay={() => setIsPlaying(p => !p)}
        onResetWindow={() => {
          setIsPlaying(false);
          setStartPct(0);
          setEndPct(100);
        }}
      />

      {toastMsg && (
        <div className="hud-toast" role="status">
          {toastMsg}
        </div>
      )}

      <ImportAndXModal
        isOpen={importOpen}
        xBearerToken={xBearerToken}
        onClose={() => setImportOpen(false)}
        onSaveXBearerToken={token => setXBearerToken(token)}
        onArchiveImported={({ importedCount, center: impCenter }) => {
          setImportOpen(false);
          setActiveTrail(null);
          setSelectedPlatforms([]);
          setCenter(impCenter);
          setRadiusKm(25);
          setFlyRequest(prev => ({
            lat: impCenter.lat,
            lon: impCenter.lon,
            zoom: 13.8,
            pitch: 52,
            seq: (prev?.seq || 0) + 1,
          }));
          showToast(`Plotted ${importedCount} geolocated archive records.`);
        }}
      />

      {/* Native Lightbox Modal Dialog for Geolocated Media */}
      <dialog
        ref={lightboxRef}
        {...({ closedby: 'any' } as any)}
        aria-labelledby={lightboxTitleId}
        className="godsear-lightbox"
      >
        {lightboxMedia && (
          <div className="lightbox-inner">
            <div className="lightbox-bar">
              <div id={lightboxTitleId}>
                <strong>{lightboxMedia.post.authorHandle}</strong> · {lightboxMedia.post.placeLabel}{' '}
                ({lightboxMedia.post.lat.toFixed(5)}°, {lightboxMedia.post.lon.toFixed(5)}°)
              </div>
              <button
                type="button"
                className="insp-dismiss"
                onClick={() => lightboxRef.current?.close()}
                aria-label="Close media viewer"
              >
                ✕
              </button>
            </div>
            <img src={lightboxMedia.url} alt={lightboxMedia.post.text} />
            <p>{lightboxMedia.post.text}</p>
          </div>
        )}
      </dialog>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
