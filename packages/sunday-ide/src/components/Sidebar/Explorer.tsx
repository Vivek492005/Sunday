/**
 * Sunday Explorer — custom file tree. Lazy-loaded directories, inline
 * create/rename, context menu, live refresh on fs changes.
 * Nothing here comes from VS Code.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIde } from '../../state/ideStore';
import { fileService, FsEntry } from '../../services/fileService';
import { badgeForFile } from '../../services/languageMap';
import {
  SunLogo,
  ExplorerIcon,
  ChevronRight,
  ChevronDown,
  PlusIcon,
  FolderPlusIcon,
  RefreshIcon,
} from '../icons';

interface TreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
}

function joinPath(dir: string, name: string): string {
  return dir.replace(/[/\\]$/, '') + '/' + name;
}

function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(0, idx);
}

export function Explorer() {
  const { state, dispatch } = useIde();
  const [children, setChildren] = useState<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'dir' } | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; node: TreeNode | null } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDir = useCallback(async (dirPath: string) => {
    try {
      const entries: FsEntry[] = await fileService.readDir(dirPath);
      setChildren((prev) => {
        const next = new Map(prev);
        next.set(
          dirPath,
          entries.map((e) => ({ path: e.path, name: e.name, isDirectory: e.isDirectory })),
        );
        return next;
      });
    } catch (err) {
      console.error('readDir failed', dirPath, err);
    }
  }, []);

  // (re)load root when folder changes
  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set());
    setSelected(null);
    if (state.rootFolder) void loadDir(state.rootFolder);
  }, [state.rootFolder, loadDir]);

  // live refresh on fs changes (debounced)
  useEffect(() => {
    if (!state.rootFolder) return;
    const off = (() => {
      try {
        return fileService.onFsChanged(() => {
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(() => {
            void loadDir(state.rootFolder as string);
            setExpanded((prev) => {
              prev.forEach((p) => void loadDir(p));
              return new Set(prev);
            });
          }, 400);
        });
      } catch {
        return () => undefined;
      }
    })();
    return () => {
      off();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [state.rootFolder, loadDir]);

  // "New File" requested from the title bar
  useEffect(() => {
    const handler = () => {
      const dir = selected && children.get(selected)?.[0]?.isDirectory !== undefined && isDirPath(selected)
        ? selected
        : state.rootFolder;
      if (dir) {
        setExpanded((prev) => new Set(prev).add(dir));
        void loadDir(dir).then(() => setCreating({ dir, kind: 'file' }));
      }
    };
    window.addEventListener('sunday:new-file', handler);
    return () => window.removeEventListener('sunday:new-file', handler);
  }, [selected, children, state.rootFolder, loadDir]);

  const isDirPath = (p: string): boolean => {
    if (p === state.rootFolder) return true;
    for (const nodes of children.values()) {
      const n = nodes.find((x) => x.path === p);
      if (n) return n.isDirectory;
    }
    return false;
  };

  const toggleDir = (node: TreeNode) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else {
        next.add(node.path);
        if (!children.has(node.path)) void loadDir(node.path);
      }
      return next;
    });
  };

  const openNode = (node: TreeNode) => {
    setSelected(node.path);
    if (node.isDirectory) toggleDir(node);
    else dispatch({ type: 'OPEN_FILE', path: node.path });
  };

  const submitCreate = async (name: string) => {
    if (!creating) return;
    const trimmed = name.trim();
    setCreating(null);
    if (!trimmed) return;
    const target = joinPath(creating.dir, trimmed);
    try {
      if (creating.kind === 'file') {
        await fileService.createFile(target);
        await loadDir(creating.dir);
        dispatch({ type: 'OPEN_FILE', path: target });
      } else {
        await fileService.createDir(target);
        await loadDir(creating.dir);
        setExpanded((prev) => new Set(prev).add(target));
      }
    } catch (err) {
      console.error('create failed', err);
    }
  };

  const submitRename = async (node: TreeNode, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === node.name) return;
    const target = joinPath(parentDir(node.path), trimmed);
    try {
      await fileService.renamePath(node.path, target);
      if (node.isDirectory) {
        setExpanded((prev) => {
          const next = new Set<string>();
          prev.forEach((p) => next.add(p === node.path ? target : p));
          return next;
        });
      } else {
        dispatch({ type: 'RENAME_FILE', oldPath: node.path, newPath: target });
      }
      await loadDir(parentDir(node.path));
      setSelected(target);
    } catch (err) {
      console.error('rename failed', err);
    }
  };

  const deleteNode = async (node: TreeNode) => {
    setCtx(null);
    if (!window.confirm(`Delete "${node.name}"?`)) return;
    try {
      await fileService.deletePath(node.path);
      state.openFiles.forEach((f) => {
        if (f.path === node.path || f.path.startsWith(node.path + '/')) {
          dispatch({ type: 'CLOSE_FILE', path: f.path });
        }
      });
      await loadDir(parentDir(node.path));
    } catch (err) {
      console.error('delete failed', err);
    }
  };

  const openFolder = async () => {
    try {
      const folder = await fileService.openFolder();
      if (folder) {
        dispatch({ type: 'SET_ROOT', folder });
        dispatch({ type: 'ADD_RECENT', folder });
        void fileService.watchStart(folder).catch(() => undefined);
        const branch = await fileService.gitBranch(folder).catch(() => null);
        dispatch({ type: 'SET_BRANCH', branch });
      }
    } catch (err) {
      console.error('open folder failed', err);
    }
  };

  if (!state.rootFolder) {
    return (
      <div className="sunday-explorer-body">
        <div className="sunday-empty-state">
          <SunLogo size={44} />
          <div style={{ fontSize: 14, color: 'var(--sunday-fg-dim)' }}>No folder open</div>
          <button className="sunday-btn" onClick={() => void openFolder()}>
            Open Folder
          </button>
        </div>
      </div>
    );
  }

  const rootNodes = children.get(state.rootFolder) ?? [];

  return (
    <>
      <div className="sunday-sidebar-header">
        <span className="title">EXPLORER</span>
        <div className="sunday-icon-actions">
          <button
            className="sunday-icon-btn"
            title="New file"
            onClick={() => {
              setExpanded((p) => new Set(p).add(state.rootFolder as string));
              setCreating({ dir: state.rootFolder as string, kind: 'file' });
            }}
          >
            <PlusIcon />
          </button>
          <button
            className="sunday-icon-btn"
            title="New folder"
            onClick={() => {
              setExpanded((p) => new Set(p).add(state.rootFolder as string));
              setCreating({ dir: state.rootFolder as string, kind: 'dir' });
            }}
          >
            <FolderPlusIcon />
          </button>
          <button
            className="sunday-icon-btn"
            title="Refresh"
            onClick={() => {
              void loadDir(state.rootFolder as string);
              expanded.forEach((p) => void loadDir(p));
            }}
          >
            <RefreshIcon />
          </button>
          <button className="sunday-icon-btn" title="Open folder" onClick={() => void openFolder()}>
            <ExplorerIcon size={16} />
          </button>
        </div>
      </div>
      <div className="sunday-explorer-body" onClick={() => setCtx(null)}>
        {rootNodes.map((n) => (
          <TreeRow
            key={n.path}
            node={n}
            depth={0}
            children={children}
            expanded={expanded}
            selected={selected}
            renaming={renaming}
            creating={creating}
            onOpen={openNode}
            onToggle={toggleDir}
            onContext={(e, node) => {
              e.preventDefault();
              e.stopPropagation();
              setSelected(node.path);
              setCtx({ x: e.clientX, y: e.clientY, node });
            }}
            onSubmitRename={submitRename}
            onSubmitCreate={submitCreate}
            onCancelInline={() => {
              setRenaming(null);
              setCreating(null);
            }}
          />
        ))}
      </div>
      {ctx && (
        <div
          className="sunday-ctx"
          style={{ left: Math.min(ctx.x, window.innerWidth - 230), top: Math.min(ctx.y, window.innerHeight - 220) }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              const dir = ctx.node && ctx.node.isDirectory ? ctx.node.path : parentDir(ctx.node?.path ?? (state.rootFolder as string));
              setCtx(null);
              if (ctx.node?.isDirectory) setExpanded((p) => new Set(p).add(ctx.node!.path));
              setCreating({ dir, kind: 'file' });
            }}
          >
            New File
          </button>
          <button
            onClick={() => {
              const dir = ctx.node && ctx.node.isDirectory ? ctx.node.path : parentDir(ctx.node?.path ?? (state.rootFolder as string));
              setCtx(null);
              if (ctx.node?.isDirectory) setExpanded((p) => new Set(p).add(ctx.node!.path));
              setCreating({ dir, kind: 'dir' });
            }}
          >
            New Folder
          </button>
          {ctx.node && (
            <>
              <hr />
              <button onClick={() => { setCtx(null); setRenaming(ctx.node!.path); }}>Rename</button>
              <button className="danger" onClick={() => void deleteNode(ctx.node!)}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

function InlineInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="sunday-tree-rename"
      autoFocus
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit(value);
        else if (e.key === 'Escape') onCancel();
        e.stopPropagation();
      }}
      onBlur={() => onSubmit(value)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function TreeRow({
  node,
  depth,
  children,
  expanded,
  selected,
  renaming,
  creating,
  onOpen,
  onToggle,
  onContext,
  onSubmitRename,
  onSubmitCreate,
  onCancelInline,
}: {
  node: TreeNode;
  depth: number;
  children: Map<string, TreeNode[]>;
  expanded: Set<string>;
  selected: string | null;
  renaming: string | null;
  creating: { dir: string; kind: 'file' | 'dir' } | null;
  onOpen: (n: TreeNode) => void;
  onToggle: (n: TreeNode) => void;
  onContext: (e: React.MouseEvent, n: TreeNode) => void;
  onSubmitRename: (n: TreeNode, v: string) => void;
  onSubmitCreate: (v: string) => void;
  onCancelInline: () => void;
}) {
  const isOpen = expanded.has(node.path);
  const kids = children.get(node.path) ?? [];
  const showCreateHere = creating?.dir === node.path && isOpen;

  return (
    <div>
      <div
        className={`sunday-tree-row${selected === node.path ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onOpen(node)}
        onContextMenu={(e) => onContext(e, node)}
        title={node.path}
      >
        <span
          className="chevron"
          onClick={(e) => {
            e.stopPropagation();
            if (node.isDirectory) onToggle(node);
          }}
        >
          {node.isDirectory ? (isOpen ? <ChevronDown /> : <ChevronRight />) : null}
        </span>
        {node.isDirectory ? (
          <ExplorerIcon size={15} color="var(--sunday-accent)" />
        ) : (
          <span className="file-badge">{badgeForFile(node.name)}</span>
        )}
        {renaming === node.path ? (
          <InlineInput
            initial={node.name}
            placeholder="Rename…"
            onSubmit={(v) => onSubmitRename(node, v)}
            onCancel={onCancelInline}
          />
        ) : (
          <span className="name">{node.name}</span>
        )}
      </div>
      {showCreateHere && (
        <div style={{ paddingLeft: 8 + (depth + 1) * 16, paddingRight: 8, paddingBottom: 4 }}>
          <InlineInput
            initial=""
            placeholder={creating.kind === 'file' ? 'File name…' : 'Folder name…'}
            onSubmit={onSubmitCreate}
            onCancel={onCancelInline}
          />
        </div>
      )}
      {node.isDirectory &&
        isOpen &&
        kids.map((k) => (
          <TreeRow
            key={k.path}
            node={k}
            depth={depth + 1}
            children={children}
            expanded={expanded}
            selected={selected}
            renaming={renaming}
            creating={creating}
            onOpen={onOpen}
            onToggle={onToggle}
            onContext={onContext}
            onSubmitRename={onSubmitRename}
            onSubmitCreate={onSubmitCreate}
            onCancelInline={onCancelInline}
          />
        ))}
    </div>
  );
}
