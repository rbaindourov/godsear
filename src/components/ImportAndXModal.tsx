import React, { useEffect, useId, useRef, useState } from 'react';
import type { GeoPost } from '../../server/types';
import { getApiPrefix } from '../utils/apiPrefix';

interface ImportAndXModalProps {
  isOpen: boolean;
  xBearerToken: string;
  onClose: () => void;
  onSaveXBearerToken: (token: string) => void;
  onArchiveImported: (result: {
    importedCount: number;
    center: { lat: number; lon: number };
    posts: GeoPost[];
  }) => void;
}

export function ImportAndXModal({
  isOpen,
  xBearerToken,
  onClose,
  onSaveXBearerToken,
  onArchiveImported,
}: ImportAndXModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const [tokenInput, setTokenInput] = useState(xBearerToken);
  const [defaultHandle, setDefaultHandle] = useState('');
  const [rawPaste, setRawPaste] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTokenInput(xBearerToken);
  }, [xBearerToken]);

  // Open/close native modal <dialog> and attach Safari closedBy fallback
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    let fallbackClick: ((event: MouseEvent) => void) | null = null;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      fallbackClick = (event: MouseEvent) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isInside =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!isInside) {
          dialog.close();
        }
      };
      dialog.addEventListener('click', fallbackClick);
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      if (fallbackClick) {
        dialog.removeEventListener('click', fallbackClick);
      }
    };
  }, [onClose]);

  const submitArchiveContent = async (content: string) => {
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await fetch(`${getApiPrefix()}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawContent: content,
          defaultHandle: defaultHandle.trim() || 'x_archive',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data?.error || 'Could not parse geolocated records from archive.');
        return;
      }
      setStatusMsg(`Imported ${data.importedCount} geolocated posts into ephemeral memory.`);
      onArchiveImported(data);
    } catch {
      setErrorMsg('Failed to upload archive to local GodsEar server.');
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await submitArchiveContent(text);
  };

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as any)}
      aria-labelledby={titleId}
      className="godsear-modal"
    >
      <div className="modal-inner">
        <div className="modal-header">
          <div>
            <span className="drawer-eyebrow">EPHEMERAL SESSION CONNECTOR</span>
            <h2 id={titleId}>X / Twitter Live API &amp; Geo-Archive Importer</h2>
          </div>
          <button
            type="button"
            className="insp-dismiss"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <section className="modal-section">
          <h3>1. Live X API v2 Bearer Token (Session-Only, Zero Disk Storage)</h3>
          <p>
            Supply an X API v2 Bearer Token to include live <code>api.x.com/2/tweets/search/recent</code>{' '}
            sweeps alongside Bluesky, Reddit, Mastodon, iNaturalist GPS, and Wikimedia EXIF.
          </p>
          <div className="token-row">
            <input
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="AAAA... (held in browser memory only)"
              autoComplete="off"
            />
            <button
              type="button"
              className="action-btn-cyan"
              onClick={() => {
                onSaveXBearerToken(tokenInput.trim());
                setStatusMsg(
                  tokenInput.trim()
                    ? 'X API v2 Bearer Token active for live sweeps.'
                    : 'Cleared session X API token.'
                );
              }}
            >
              {tokenInput.trim() ? 'Activate Token' : 'Clear'}
            </button>
          </div>
        </section>

        <section className="modal-section">
          <h3>2. Drop in Real Geolocated X / Social Exports (tweets.js, GeoJSON, JSON, CSV)</h3>
          <p>
            Upload an official X Data Export <code>tweets.js</code> file, GeoJSON{' '}
            <code>FeatureCollection</code>, JSON tweet array, or CSV (<code>lat,lon,handle,text,created_at</code>)
            to plot exact GPS tweets and trace <code>@handle</code> movement paths.
          </p>

          <div className="import-controls">
            <label className="handle-field">
              <span>Fallback @handle (for X tweets.js archives)</span>
              <input
                type="text"
                value={defaultHandle}
                onChange={e => setDefaultHandle(e.target.value)}
                placeholder="@username"
              />
            </label>

            <label className="file-drop-zone">
              <input
                type="file"
                accept=".js,.json,.geojson,.csv,.txt"
                onChange={handleFileChange}
                disabled={busy}
              />
              <span>
                {busy
                  ? 'Parsing geolocated records...'
                  : 'Select tweets.js / .geojson / .json / .csv file'}
              </span>
            </label>
          </div>

          <details className="paste-details">
            <summary>Or paste raw JSON / CSV geo-tweet payload directly</summary>
            <textarea
              rows={5}
              value={rawPaste}
              onChange={e => setRawPaste(e.target.value)}
              placeholder='[{"id":"1","screen_name":"alice","text":"Coffee on Abbot Kinney","lat":33.9911,"lon":-118.4696,"created_at":"2026-11-13T18:20:00Z"}]'
            />
            <button
              type="button"
              className="action-btn-cyan"
              disabled={busy || !rawPaste.trim()}
              onClick={() => submitArchiveContent(rawPaste)}
            >
              Plot Pasted Records
            </button>
          </details>
        </section>

        {statusMsg && <p className="modal-ok">{statusMsg}</p>}
        {errorMsg && <p className="modal-err">{errorMsg}</p>}
      </div>
    </dialog>
  );
}
