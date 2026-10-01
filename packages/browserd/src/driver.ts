import type { AxNode, ConsoleEntry, NetworkEntry } from '@sunday/protocol';

export type { AxNode, ConsoleEntry, NetworkEntry };

/** Result of opening/navigating to a page. */
export interface OpenResult {
  url: string;
  title: string;
}

/** Receives one screencast frame — JPEG bytes. */
export type ScreencastFrameHandler = (jpeg: Buffer) => void;

/** Options for Driver.startRecording. */
export interface RecordingStartOptions {
  video?: boolean;
  trace?: boolean;
  /** Directory the driver writes recording artifacts into. The server creates
   *  it (media dir under the browser session) before calling. */
  dir: string;
}

/** Artifact paths produced by Driver.stopRecording. */
export interface RecordingStopResult {
  videoPath?: string;
  tracePath?: string;
}

/** Accessibility-tree snapshot — the primary browser observation (§18.2). */
export interface SnapshotResult {
  url: string | null;
  title: string;
  nodes: AxNode[];
}

/**
 * Driver — the browser backend behind browserd (§18.2).
 *
 * Implementations: PlaywrightDriver (real Chromium via Playwright, lazily
 * loaded so tests never touch it) and FakeDriver (in-memory DOM stub for
 * hermetic tests). Refs are stable element handles minted per snapshot.
 */
export interface Driver {
  /** Human-readable backend name, e.g. "playwright" / "fake". */
  readonly name: string;

  open(url: string): Promise<OpenResult>;
  snapshot(): Promise<SnapshotResult>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, opts?: { submit?: boolean }): Promise<void>;
  press(key: string): Promise<void>;
  scroll(opts?: { ref?: string; dx?: number; dy?: number }): Promise<void>;
  wait(opts?: { ms?: number; selector?: string; timeoutMs?: number }): Promise<void>;
  /** Restricted page-context eval. Implementations must refuse when the
   *  server policy disables eval. */
  eval(fn: string, arg?: unknown): Promise<unknown>;
  /** PNG screenshot bytes. */
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
  consoleEntries(limit?: number): Promise<ConsoleEntry[]>;
  networkEntries(limit?: number): Promise<NetworkEntry[]>;
  /**
   * Start a live JPEG screencast: onFrame is called with JPEG bytes for every
   * captured frame until stopScreencast(). Implementations choose the frame
   * rate (the server throttles notification delivery to ~2fps).
   */
  startScreencast(onFrame: ScreencastFrameHandler): Promise<void>;
  /** Stop the active screencast. Idempotent — safe to call when not started. */
  stopScreencast(): Promise<void>;
  /** History navigation. No-ops at the ends of the history stack. */
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  /**
   * Start recording the session. `opts.dir` is the media directory the
   * artifacts land in (as video.webm / trace.zip). Calling again while
   * recording restarts it.
   */
  startRecording(opts: RecordingStartOptions): Promise<void>;
  /** Stop recording and return the artifact paths (absent for kinds that
   *  were never started). */
  stopRecording(): Promise<RecordingStopResult>;
  close(): Promise<void>;
}

/** Error thrown for bad refs, unknown selectors, failed waits, etc. */
export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverError';
  }
}
