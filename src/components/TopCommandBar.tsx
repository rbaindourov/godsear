import React, { useState } from 'react';
import type { PlatformId } from '../../server/types';
import { PLATFORM_META, type MapStyleMode } from './GodsEarMap';

const RADIUS_OPTIONS = [
  { label: '250m', km: 0.25 },
  { label: '1km', km: 1 },
  { label: '5km', km: 5 },
  { label: '25km', km: 25 },
];

const QUICK_SECTORS = [
  { label: 'Downtown LA', lat: 34.0522, lon: -118.2437, radiusKm: 5 },
  { label: 'Hollywood & Vine', lat: 34.1016, lon: -118.3267, radiusKm: 2 },
  { label: 'Santa Monica Pier', lat: 34.0094, lon: -118.4973, radiusKm: 3 },
  { label: 'Times Square NYC', lat: 40.758, lon: -73.9855, radiusKm: 3 },
  { label: 'Shibuya Tokyo', lat: 35.6595, lon: 139.7004, radiusKm: 3 },
  { label: 'Soho London', lat: 51.5136, lon: -0.1365, radiusKm: 3 },
];

interface TopCommandBarProps {
  areaLabel: string;
  totalSignals: number;
  exactGpsCount: number;
  radiusKm: number;
  exactOnly: boolean;
  styleMode: MapStyleMode;
  sweeping: boolean;
  selectedPlatforms: PlatformId[];
  platformCounts: Record<PlatformId, number>;
  xConnected: boolean;
  onSearchSubmit: (rawQuery: string) => void;
  onSelectSector: (lat: number, lon: number, radiusKm: number) => void;
  onRadiusChange: (km: number) => void;
  onToggleExactOnly: () => void;
  onStyleModeChange: (mode: MapStyleMode) => void;
  onZoomGlobe: () => void;
  onLocateMe: () => void;
  onRefreshSweep: () => void;
  onTogglePlatform: (platform: PlatformId | 'all') => void;
  onOpenImportModal: () => void;
}

export function TopCommandBar({
  areaLabel,
  totalSignals,
  exactGpsCount,
  radiusKm,
  exactOnly,
  styleMode,
  sweeping,
  selectedPlatforms,
  platformCounts,
  xConnected,
  onSearchSubmit,
  onSelectSector,
  onRadiusChange,
  onToggleExactOnly,
  onStyleModeChange,
  onZoomGlobe,
  onLocateMe,
  onRefreshSweep,
  onTogglePlatform,
  onOpenImportModal,
}: TopCommandBarProps) {
  const [searchInput, setSearchInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchInput.trim()) return;
    onSearchSubmit(searchInput.trim());
  };

  const allSelected = selectedPlatforms.length === 0;

  return (
    <div className="hud-top-stack">
      <header className="hud-command-bar" aria-label="GodsEar spatial controls">
        <div className="brand-cluster">
          <div className="brand-reticle" aria-hidden="true">
            <span />
          </div>
          <div className="brand-copy">
            <strong>GODSEAR</strong>
            <small title={areaLabel}>{areaLabel || 'Sweeping sector...'}</small>
          </div>
          <div className="signal-readout" title="Signals inside active listening cone">
            <span className={`live-dot ${sweeping ? 'sweeping' : ''}`} />
            <b>{totalSignals}</b> signals · <em>{exactGpsCount} GPS</em>
          </div>
        </div>

        <form className="command-search" onSubmit={handleSubmit}>
          <input
            type="search"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Jump to street/city, lat,lon, keyword, or @handle..."
            aria-label="Search street address, coordinates, keyword, or @handle"
          />
          <button type="submit" className="search-go-btn">
            Sweep
          </button>
        </form>

        <div className="radius-pill-group" role="group" aria-label="Sweep radius">
          {RADIUS_OPTIONS.map(opt => (
            <button
              key={opt.label}
              type="button"
              className={radiusKm === opt.km ? 'active' : ''}
              onClick={() => onRadiusChange(opt.km)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="view-pill-group" role="group" aria-label="Viewport mode">
          <button
            type="button"
            className={exactOnly ? 'active-emerald' : ''}
            onClick={onToggleExactOnly}
            title="Show only posts with embedded hardware GPS or camera EXIF coordinates"
          >
            🎯 Exact GPS Only
          </button>
          <button
            type="button"
            className={styleMode === 'streets3d' ? 'active' : ''}
            onClick={() => onStyleModeChange('streets3d')}
          >
            3D Streets
          </button>
          <button
            type="button"
            className={styleMode === 'satellite' ? 'active' : ''}
            onClick={() => onStyleModeChange('satellite')}
          >
            Satellite
          </button>
          <button type="button" onClick={onZoomGlobe} title="Zoom out to 3D Orbital Globe">
            🌐 Globe
          </button>
          <button type="button" onClick={onLocateMe} title="Sweep my current browser GPS">
            📍 Locate
          </button>
          <button
            type="button"
            onClick={onRefreshSweep}
            disabled={sweeping}
            title="Force fresh live sweep"
          >
            {sweeping ? '⟳' : '↻'}
          </button>
        </div>

        <button
          type="button"
          className={`import-x-btn ${xConnected ? 'connected' : ''}`}
          onClick={onOpenImportModal}
        >
          {xConnected ? '✓ X Live + Import' : '＋ X / Import'}
        </button>
      </header>

      {/* Secondary compact chip row: Platform filters + 1-click sector jumps */}
      <div className="hud-sub-strip">
        <div className="platform-pills" role="group" aria-label="Filter social platforms">
          <button
            type="button"
            className={`plat-pill ${allSelected ? 'selected' : ''}`}
            onClick={() => onTogglePlatform('all')}
          >
            All Networks
          </button>
          {(Object.keys(PLATFORM_META) as PlatformId[]).map(pid => {
            const meta = PLATFORM_META[pid];
            const isSelected = selectedPlatforms.includes(pid);
            const count = platformCounts[pid] || 0;
            return (
              <button
                key={pid}
                type="button"
                className={`plat-pill ${isSelected ? 'selected' : ''}`}
                style={{ '--plat-color': meta.color } as React.CSSProperties}
                onClick={() => onTogglePlatform(pid)}
              >
                <i className="plat-dot" />
                {meta.short} <span>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="quick-sector-pills" aria-label="Quick sector jumps">
          {QUICK_SECTORS.map(sec => (
            <button
              key={sec.label}
              type="button"
              className="sector-chip"
              onClick={() => onSelectSector(sec.lat, sec.lon, sec.radiusKm)}
            >
              {sec.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
