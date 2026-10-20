/**
 * Auto-Update UI — custom Sunday modal + status-bar pill.
 *
 * UpdateDialog: on open it checks via updateService (gateway → GitHub
 * fallback in the main process) and walks the honest states:
 * checking → up-to-date / available → downloading (indeterminate
 * progress — the IPC bridge reports completion, not byte counts, so no
 * fake percentages) → downloaded → installing. Errors are shown
 * verbatim with a Retry.
 *
 * Installing dispatches 'sunday:update:installing' after the installer
 * has been launched so the app shell can quit and let the installer
 * finish the upgrade.
 *
 * UpdatePill: status-bar helper. Checks on mount, listens for
 * 'sunday:update:status' (broadcast by updateService.check) and for
 * 'sunday:update:open-dialog' (the palette command), and opens the
 * dialog on click.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  updateService,
  type UpdateCheckResult,
  type UpdateDownloadResult,
} from '../../services/updateService';
import { CloseIcon } from '../icons';
import './update.css';

type Phase =
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdateDialogProps {
  open: boolean;
  onClose(): void;
}

function notesExcerpt(notes: string | undefined, max = 600): string | null {
  if (!notes || !notes.trim()) return null;
  const trimmed = notes.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

export function UpdateDialog({ open, onClose }: UpdateDialogProps) {
  // The palette command dispatches 'sunday:update:open-dialog' — listen
  // for it here too so the dialog opens even when the parent did not wire
  // that event to the `open` prop.
  const [eventOpen, setEventOpen] = useState(false);
  const visible = open || eventOpen;

  const [phase, setPhase] = useState<Phase>('checking');
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [downloaded, setDownloaded] = useState<UpdateDownloadResult | null>(null);
  const [error, setError] = useState<string>('');
  const checkSeq = useRef(0);

  const close = useCallback(() => {
    setEventOpen(false);
    onClose();
  }, [onClose]);

  const runCheck = useCallback(async () => {
    const seq = ++checkSeq.current;
    setPhase('checking');
    setError('');
    setDownloaded(null);
    try {
      const r = await updateService.check();
      if (checkSeq.current !== seq) return; // superseded by a newer check
      setResult(r);
      if (r.available) {
        setPhase('available');
      } else if (r.error) {
        setError(r.error);
        setPhase('error');
      } else {
        setPhase('uptodate');
      }
    } catch (e) {
      if (checkSeq.current !== seq) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    if (visible) void runCheck();
  }, [visible, runCheck]);

  useEffect(() => {
    const onOpenDialog = () => setEventOpen(true);
    window.addEventListener('sunday:update:open-dialog', onOpenDialog);
    return () => window.removeEventListener('sunday:update:open-dialog', onOpenDialog);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, close]);

  if (!visible) return null;

  const download = async () => {
    if (!result?.downloadUrl) return;
    setPhase('downloading');
    setError('');
    try {
      const d = await updateService.download(result.downloadUrl);
      setDownloaded(d);
      setPhase('downloaded');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const install = async () => {
    if (!downloaded) return;
    setPhase('installing');
    setError('');
    try {
      await updateService.install(downloaded.path);
      // The installer is launched (detached). Tell the app shell so it
      // can quit and let the installer finish the upgrade.
      window.dispatchEvent(
        new CustomEvent('sunday:update:installing', {
          detail: { path: downloaded.path, version: result?.latest },
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const excerpt = notesExcerpt(result?.releaseNotes);
  const published = formatDate(result?.publishedAt);

  return (
    <div className="sunday-update-overlay" onClick={close}>
      <div
        className="sunday-update-modal"
        role="dialog"
        aria-label="Sunday updates"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sunday-update-header">
          <div>
            <h2>Sunday Updates</h2>
            <p>Stay on the latest Sunday IDE release.</p>
          </div>
          <button className="sunday-update-close" onClick={close} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="sunday-update-body">
          {phase === 'checking' && (
            <>
              <p className="sunday-update-status">Checking for updates…</p>
              <div className="sunday-update-progress">
                <div className="sunday-update-progress-bar" />
              </div>
            </>
          )}

          {phase === 'uptodate' && (
            <>
              <p className="sunday-update-version">You&rsquo;re up to date</p>
              <p className="sunday-update-status">
                {result?.latest
                  ? `Sunday v${result.latest} is the latest release.`
                  : 'No newer Sunday release is available right now.'}
              </p>
              <div className="sunday-update-footer">
                <button className="sunday-update-primary" onClick={close}>
                  Done
                </button>
              </div>
            </>
          )}

          {(phase === 'available' || phase === 'downloading' || phase === 'downloaded') &&
            result && (
              <>
                <p className="sunday-update-version">
                  Sunday v{result.latest} is available
                </p>
                <p className="sunday-update-meta">
                  {[result.assetName, published ? `Released ${published}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {excerpt && <div className="sunday-update-notes">{excerpt}</div>}

                {phase === 'available' && (
                  <div className="sunday-update-footer">
                    <button className="sunday-update-secondary" onClick={close}>
                      Later
                    </button>
                    <button
                      className="sunday-update-primary"
                      onClick={() => void download()}
                      disabled={!result.downloadUrl}
                    >
                      Download
                    </button>
                  </div>
                )}

                {phase === 'downloading' && (
                  <>
                    <div className="sunday-update-progress">
                      <div className="sunday-update-progress-bar" />
                    </div>
                    <p className="sunday-update-status">
                      Downloading {result.assetName ?? 'the installer'}…
                    </p>
                  </>
                )}

                {phase === 'downloaded' && downloaded && (
                  <>
                    <p className="sunday-update-status">
                      Download complete ({(downloaded.sizeBytes / (1024 * 1024)).toFixed(1)} MB).
                      Sunday will close while the installer runs.
                    </p>
                    <div className="sunday-update-footer">
                      <button className="sunday-update-secondary" onClick={close}>
                        Later
                      </button>
                      <button
                        className="sunday-update-primary"
                        onClick={() => void install()}
                      >
                        Restart &amp; Install
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

          {phase === 'installing' && (
            <p className="sunday-update-status">
              Installer launched — Sunday will close so the update can finish. If nothing
              happens, run the downloaded installer from your temp folder.
            </p>
          )}

          {phase === 'error' && (
            <div className="sunday-update-error">
              <p>{error || 'Something went wrong while checking for updates.'}</p>
              <div className="sunday-update-footer">
                <button className="sunday-update-secondary" onClick={close}>
                  Close
                </button>
                <button className="sunday-update-primary" onClick={() => void runCheck()}>
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export interface UpdatePillProps {
  /**
   * Optional: when the parent owns the UpdateDialog instance, pass a
   * callback that opens it. Without one, the pill opens its own dialog.
   */
  onOpen?: () => void;
}

/**
 * Status-bar pill: 'Update available: vX.Y.Z'. Invisible until a check
 * finds an update. Triggers a check on mount and stays in sync via the
 * 'sunday:update:status' event; the palette command's
 * 'sunday:update:open-dialog' event opens its dialog directly.
 */
export function UpdatePill({ onOpen }: UpdatePillProps = {}) {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void updateService
      .check()
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => undefined);
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent<UpdateCheckResult>).detail;
      if (detail) setResult(detail);
    };
    const onOpenDialog = () => {
      if (onOpen) onOpen();
      else setDialogOpen(true);
    };
    window.addEventListener('sunday:update:status', onStatus);
    window.addEventListener('sunday:update:open-dialog', onOpenDialog);
    return () => {
      cancelled = true;
      window.removeEventListener('sunday:update:status', onStatus);
      window.removeEventListener('sunday:update:open-dialog', onOpenDialog);
    };
  }, [onOpen]);

  const handleClick = () => {
    if (onOpen) onOpen();
    else setDialogOpen(true);
  };

  return (
    <>
      {result?.available && result.latest && (
        <button
          className="sunday-update-pill"
          title="A new Sunday version is available — click to update"
          onClick={handleClick}
        >
          Update available: v{result.latest}
        </button>
      )}
      {!onOpen && (
        <UpdateDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      )}
    </>
  );
}
