import React, { useEffect, useMemo, useRef } from 'react';
import type { GeoPost } from '../../server/types';

interface TimeScrubberBarProps {
  allPosts: GeoPost[];
  startPct: number;
  endPct: number;
  isPlaying: boolean;
  onRangePctChange: (startPct: number, endPct: number) => void;
  onTogglePlay: () => void;
  onResetWindow: () => void;
}

const BIN_COUNT = 28;

export function TimeScrubberBar({
  allPosts,
  startPct,
  endPct,
  isPlaying,
  onRangePctChange,
  onTogglePlay,
  onResetWindow,
}: TimeScrubberBarProps) {
  const startSliderRef = useRef<HTMLInputElement>(null);
  const endSliderRef = useRef<HTMLInputElement>(null);

  const { activeStartMs, activeEndMs, bins, maxBin } = useMemo(() => {
    const sorted = [...allPosts]
      .map(p => ({ post: p, ms: Date.parse(p.createdAt) }))
      .filter(x => Number.isFinite(x.ms))
      .sort((a, b) => a.ms - b.ms);

    if (sorted.length === 0) {
      const now = Date.now();
      return {
        activeStartMs: now - 86400_000,
        activeEndMs: now,
        bins: Array.from({ length: BIN_COUNT }, () => ({ total: 0, exact: 0 })),
        maxBin: 1,
      };
    }

    const buckets = Array.from({ length: BIN_COUNT }, () => ({ total: 0, exact: 0 }));
    const n = sorted.length;
    for (let i = 0; i < n; i++) {
      const idx = Math.min(BIN_COUNT - 1, Math.floor((i / n) * BIN_COUNT));
      buckets[idx].total += 1;
      if (sorted[i].post.precision === 'exact_gps') {
        buckets[idx].exact += 1;
      }
    }

    const startIdx = Math.min(n - 1, Math.max(0, Math.floor((startPct / 100) * (n - 1))));
    const endIdx = Math.min(n - 1, Math.max(startIdx, Math.ceil((endPct / 100) * (n - 1))));
    const peak = Math.max(1, ...buckets.map(b => b.total));

    return {
      activeStartMs: sorted[startIdx].ms,
      activeEndMs: sorted[endIdx].ms,
      bins: buckets,
      maxBin: peak,
    };
  }, [allPosts, startPct, endPct]);

  // Progressive enhancement fallback for range progress variable in older WebKit without accent-color
  useEffect(() => {
    if (typeof CSS !== 'undefined' && !CSS.supports('accent-color', '#00f2fe')) {
      startSliderRef.current?.style.setProperty('--progress', `${startPct}%`);
      endSliderRef.current?.style.setProperty('--progress', `${endPct}%`);
    }
  }, [startPct, endPct]);

  // Chronological Replay Animation
  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      const nextEnd = endPct >= 100 ? 15 : Math.min(100, endPct + 5);
      const nextStart = Math.max(0, nextEnd - 25);
      onRangePctChange(nextStart, nextEnd);
    }, 650);
    return () => window.clearInterval(timer);
  }, [isPlaying, endPct, onRangePctChange]);

  const spanMs = Math.max(0, activeEndMs - activeStartMs);

  const formatShortStamp = (ms: number) => {
    const d = new Date(ms);
    const multiDay = spanMs > 48 * 3600 * 1000;
    return multiDay
      ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : d.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  };

  const isFiltered = startPct > 0 || endPct < 100;

  return (
    <section className="hud-time-bar" aria-label="Chronological signal window">
      <div className="time-bar-head">
        <div className="time-window-label">
          <span className="time-eyebrow">TIME WINDOW</span>
          <strong>
            {formatShortStamp(activeStartMs)} → {formatShortStamp(activeEndMs)}
          </strong>
        </div>

        <div className="time-bar-actions">
          <button
            type="button"
            className={`replay-btn ${isPlaying ? 'playing' : ''}`}
            onClick={onTogglePlay}
            disabled={allPosts.length === 0}
          >
            {isPlaying ? '⏸ Pause' : '▶ Replay'}
          </button>
          {isFiltered && (
            <button type="button" className="reset-win-btn" onClick={onResetWindow}>
              ↺ Full Range
            </button>
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${BIN_COUNT * 16} 36`}
        preserveAspectRatio="none"
        className="time-histogram"
        role="img"
        aria-label="Chronological post density histogram"
      >
        {bins.map((b, i) => {
          const binPct = ((i + 0.5) / BIN_COUNT) * 100;
          const active = binPct >= startPct && binPct <= endPct;
          const totalH = Math.max(b.total > 0 ? 4 : 1, (b.total / maxBin) * 32);
          const exactH = b.total > 0 ? (b.exact / maxBin) * 32 : 0;
          const x = i * 16 + 2;

          return (
            <g key={i} opacity={active ? 0.95 : 0.25}>
              <rect
                x={x}
                y={35 - totalH}
                width={11}
                height={totalH}
                rx={2}
                fill="#38bdf8"
              />
              {exactH > 0 && (
                <rect
                  x={x}
                  y={35 - exactH}
                  width={11}
                  height={exactH}
                  rx={2}
                  fill="#00f2fe"
                />
              )}
            </g>
          );
        })}
      </svg>

      <div className="time-sliders-row">
        <label className="range-wrap">
          <span>From</span>
          <input
            ref={startSliderRef}
            type="range"
            min={0}
            max={100}
            value={startPct}
            onChange={e => {
              const v = Math.min(Number(e.target.value), endPct - 2);
              onRangePctChange(Math.max(0, v), endPct);
            }}
          />
        </label>
        <label className="range-wrap">
          <span>To</span>
          <input
            ref={endSliderRef}
            type="range"
            min={0}
            max={100}
            value={endPct}
            onChange={e => {
              const v = Math.max(Number(e.target.value), startPct + 2);
              onRangePctChange(startPct, Math.min(100, v));
            }}
          />
        </label>
      </div>
    </section>
  );
}
