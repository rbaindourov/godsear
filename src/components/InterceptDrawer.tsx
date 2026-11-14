import React, { useState } from 'react';
import type { GeoPost, PlatformId, ProviderStatus, UserTrailResponse } from '../../server/types';
import { PLATFORM_META } from './GodsEarMap';

interface InterceptDrawerProps {
  posts: GeoPost[];
  selectedPostId: string | null;
  activeTrail: UserTrailResponse | null;
  trailLoading: boolean;
  sweeping: boolean;
  areaLabel: string;
  radiusKm: number;
  keywordFilter: string;
  providers: ProviderStatus[];
  onKeywordFilterChange: (q: string) => void;
  onSelectPost: (post: GeoPost, shouldFly: boolean) => void;
  onTrackAuthor: (handle: string, platform: PlatformId) => void;
  onClearTrail: () => void;
  onOpenMedia: (url: string, post: GeoPost) => void;
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(diffSec)) return iso.slice(0, 10);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function InterceptDrawer({
  posts,
  selectedPostId,
  activeTrail,
  trailLoading,
  sweeping,
  areaLabel,
  radiusKm,
  keywordFilter,
  providers,
  onKeywordFilterChange,
  onSelectPost,
  onTrackAuthor,
  onClearTrail,
  onOpenMedia,
}: InterceptDrawerProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <button
        type="button"
        className="drawer-reopen-tab"
        onClick={() => setCollapsed(false)}
        aria-label="Open live signal feed drawer"
      >
        ◀ Signals ({posts.length})
      </button>
    );
  }

  const displayList = activeTrail && activeTrail.stops.length > 0 ? activeTrail.stops : posts;

  return (
    <aside className="hud-intercept-drawer" aria-label="Geolocated social signal stream">
      <div className="drawer-header">
        <div>
          <div className="drawer-eyebrow">
            {activeTrail
              ? 'CHRONOLOGICAL USER MOVEMENT TRAIL'
              : `SECTOR CONE · ${radiusKm >= 1 ? `${radiusKm} KM` : `${radiusKm * 1000} M`}`}
          </div>
          <h2>
            {activeTrail ? activeTrail.handle : areaLabel || 'Active Sweep Feed'}
          </h2>
        </div>
        <button
          type="button"
          className="drawer-collapse-btn"
          onClick={() => setCollapsed(true)}
          title="Collapse feed drawer"
          aria-label="Collapse feed drawer"
        >
          ▶
        </button>
      </div>

      {/* Active @user Trail Dossier Banner */}
      {(trailLoading || activeTrail) && (
        <div className="trail-dossier-banner">
          {trailLoading ? (
            <span>Tracing geolocated post history across networks...</span>
          ) : activeTrail ? (
            <>
              <div className="trail-dossier-stats">
                <strong>
                  {activeTrail.stops.length} geolocated stop
                  {activeTrail.stops.length === 1 ? '' : 's'}
                </strong>
                <span>· {activeTrail.totalDistanceKm} km traversed</span>
              </div>
              <button type="button" className="trail-clear-btn" onClick={onClearTrail}>
                ✕ Exit Trail
              </button>
            </>
          ) : null}
        </div>
      )}

      {/* Instant text/author filter inside current cone */}
      <div className="drawer-filter-row">
        <input
          type="search"
          value={keywordFilter}
          onChange={e => onKeywordFilterChange(e.target.value)}
          placeholder="Filter active cone by word, street, or @user..."
          aria-label="Filter active signals"
        />
        {keywordFilter && (
          <button
            type="button"
            className="filter-clear-x"
            onClick={() => onKeywordFilterChange('')}
            aria-label="Clear cone filter"
          >
            ✕
          </button>
        )}
      </div>

      <div className="drawer-stream">
        {sweeping && displayList.length === 0 && (
          <div className="stream-empty">
            <div className="spinner-ring" />
            <p>Sweeping live public geo-feeds for {areaLabel || 'this coordinate'}...</p>
          </div>
        )}

        {!sweeping && displayList.length === 0 && (
          <div className="stream-empty">
            <p>
              Zero public geolocated posts matched inside this {radiusKm}km cone and filter window.
            </p>
            <small>
              Expand the sweep radius (e.g. 5km or 25km), clear Exact-GPS-Only, or click another
              neighborhood on the map.
            </small>
          </div>
        )}

        {displayList.slice(0, 80).map((post, idx) => {
          const meta = PLATFORM_META[post.platform];
          const isSelected = post.id === selectedPostId;
          const stopNumber = activeTrail ? idx + 1 : null;

          return (
            <article
              key={post.id}
              className={`signal-card ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelectPost(post, true)}
            >
              <div className="signal-card-top">
                <div className="signal-badges">
                  {stopNumber !== null && (
                    <span className="stop-step-badge">#{stopNumber}</span>
                  )}
                  <span
                    className="platform-chip"
                    style={{ borderColor: meta.color, color: meta.color }}
                  >
                    {meta.short}
                  </span>
                  <span
                    className={`precision-chip ${
                      post.precision === 'exact_gps' ? 'exact' : 'place'
                    }`}
                  >
                    {post.precision === 'exact_gps'
                      ? '🎯 EXACT GPS'
                      : `📍 ${post.precision.toUpperCase()}`}
                  </span>
                </div>
                <time dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()}>
                  {formatRelativeTime(post.createdAt)}
                </time>
              </div>

              <div className="signal-author-row">
                {post.authorAvatar ? (
                  <img
                    src={post.authorAvatar}
                    alt=""
                    width={28}
                    height={28}
                    className="author-avatar"
                    loading="lazy"
                  />
                ) : (
                  <div className="author-avatar-fallback sm">
                    {post.authorName.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="author-names">
                  <strong>{post.authorName}</strong>
                  <span>{post.authorHandle}</span>
                </div>
              </div>

              <p className="signal-body">{post.text}</p>

              {post.mediaUrls.length > 0 && (
                <div className="signal-media-strip">
                  {post.mediaUrls.slice(0, 2).map(url => (
                    <button
                      key={url}
                      type="button"
                      className="signal-media-btn"
                      onClick={e => {
                        e.stopPropagation();
                        onOpenMedia(url, post);
                      }}
                    >
                      <img
                        src={url}
                        alt="Geolocated post media"
                        width={160}
                        height={96}
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              )}

              <div className="signal-place-line">
                <span title={`${post.lat.toFixed(5)}, ${post.lon.toFixed(5)}`}>
                  {post.placeLabel}
                </span>
                <code>
                  {post.lat.toFixed(4)}°, {post.lon.toFixed(4)}°
                </code>
              </div>

              <div className="signal-actions">
                <button
                  type="button"
                  className="mini-action"
                  onClick={e => {
                    e.stopPropagation();
                    onTrackAuthor(post.authorHandle, post.platform);
                  }}
                >
                  Track {post.authorHandle}
                </button>
                <a
                  href={post.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mini-link"
                  onClick={e => e.stopPropagation()}
                >
                  Original Post ↗
                </a>
              </div>
            </article>
          );
        })}
      </div>

      {/* Live Upstream Provider Telemetry Footer */}
      {providers.length > 0 && (
        <details className="drawer-providers-details">
          <summary>
            Upstream Adapters ({providers.filter(p => p.ok).length}/{providers.length} live)
          </summary>
          <ul>
            {providers.map(p => (
              <li key={p.platform}>
                <span>{PLATFORM_META[p.platform].label}</span>
                <span>
                  {p.ok ? `+${p.fetched} (${p.latencyMs}ms)` : p.note || 'offline'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}
