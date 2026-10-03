/** @sunday/cli — programmatic surface (the `sunday` bin lives in cli.js). */
export { DaemonClient, DaemonClientError, DaemonSpawnError, ProtocolMismatchError, resolveSundaydCli, CLI_VERSION, CLI_NAME } from './client.js';
export type { DaemonClientOptions, NotificationHandler } from './client.js';
export { parseArgs } from './cli.js';
