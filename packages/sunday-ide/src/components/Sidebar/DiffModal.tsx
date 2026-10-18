/**
 * Sunday diff viewer — Monaco diff editor in a modal.
 * Shows working-tree or staged diff for one file. Sunday chrome throughout.
 */
import React, { useEffect, useRef } from 'react';
import { gitService } from '../../services/gitService';
import { ensureSundayTheme, monaco } from '../../services/monacoSetup';
import { languageForFile } from '../../services/languageMap';
import { CloseIcon } from '../icons';

export function DiffModal({
  rootFolder,
  filePath,
  staged,
  onClose,
}: {
  rootFolder: string;
  filePath: string;
  staged: boolean;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [empty, setEmpty] = React.useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!hostRef.current) return;
    ensureSundayTheme();
    const theme = document.documentElement.dataset.theme === 'sunday-light' ? 'sunday-light' : 'sunday-dark';
    const diff = monaco.editor.createDiffEditor(hostRef.current, {
      theme,
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontSize: 12.5,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', ui-monospace, Menlo, Consolas, monospace",
      scrollBeyondLastLine: false,
    });
    diffRef.current = diff;

    let cancelled = false;
    void gitService.diff(rootFolder, filePath, staged).then((text) => {
      if (cancelled) return;
      setLoading(false);
      if (!text.trim()) {
        setEmpty(true);
        return;
      }
      const { oldText, newText } = splitDiff(text);
      const lang = languageForFile(filePath);
      const original = monaco.editor.createModel(oldText, lang);
      const modified = monaco.editor.createModel(newText, lang);
      diff.setModel({ original, modified });
    });

    return () => {
      cancelled = true;
      diff.getModel()?.original.dispose();
      diff.getModel()?.modified.dispose();
      diff.dispose();
      diffRef.current = null;
    };
  }, [rootFolder, filePath, staged]);

  return (
    <div className="sunday-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="sunday-modal sunday-diff-modal"
        role="dialog"
        aria-label={`Diff: ${filePath}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sunday-modal-header">
          <span className="title sunday-diff-title" title={filePath}>
            DIFF · {staged ? 'STAGED' : 'WORKING TREE'} · {filePath}
          </span>
          <button className="sunday-icon-btn" onClick={onClose} aria-label="Close diff">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="sunday-diff-host" ref={hostRef}>
          {loading && <div className="sunday-sc-hint">Loading diff…</div>}
          {empty && !loading && <div className="sunday-sc-hint">No diff available for this file.</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Best-effort reconstruction of old/new file text from a unified diff.
 * Pure and simple: handles one file's hunks; good enough for review.
 */
function splitDiff(diff: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('@@') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      continue;
    }
    if (raw.startsWith('-')) oldLines.push(raw.slice(1));
    else if (raw.startsWith('+')) newLines.push(raw.slice(1));
    else if (raw.startsWith(' ')) {
      oldLines.push(raw.slice(1));
      newLines.push(raw.slice(1));
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}
