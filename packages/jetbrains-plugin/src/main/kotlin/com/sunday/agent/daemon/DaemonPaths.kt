package com.sunday.agent.daemon

/**
 * Well-known per-user sundayd daemon paths.
 *
 * Mirrors `sharedDaemonSocketPath` / `sharedDaemonLockPath` from
 * `@sunday/protocol` (packages/protocol/src/daemon-paths.ts). These are
 * shared conventions, not wire protocol: the JetBrains plugin must compute
 * the exact same socket path as the daemon, the CLI, and the VS Code
 * extension or it will not find the shared per-user daemon.
 *
 * - POSIX: `~/.sunday/sundayd.sock`
 * - Windows: `\\.\pipe\sundayd-<username>` (sanitized)
 *
 * Lockfile (single-flight spawn mutex) on all platforms:
 * `~/.sunday/sundayd.lock`
 */
object DaemonPaths {

    fun sanitizePipeUser(name: String): String {
        val s = name.replace(Regex("[^a-zA-Z0-9_.-]"), "_").take(64)
        return s.ifEmpty { "user" }
    }

    /**
     * @param platform "win32" for Windows, anything else for POSIX.
     *   Defaults to the current OS.
     */
    fun sharedDaemonSocketPath(
        platform: String = currentPlatform(),
        username: String = currentUsername(),
        homeDir: String = System.getProperty("user.home"),
    ): String {
        return if (platform == "win32") {
            """\\.\pipe\sundayd-${sanitizePipeUser(username)}"""
        } else {
            "$homeDir/.sunday/sundayd.sock"
        }
    }

    fun sharedDaemonLockPath(
        homeDir: String = System.getProperty("user.home"),
    ): String = "$homeDir/.sunday/sundayd.lock"

    fun currentPlatform(): String {
        val os = System.getProperty("os.name").lowercase()
        return if (os.contains("win")) "win32" else os
    }

    fun currentUsername(): String {
        return System.getProperty("user.name")
            ?: System.getenv("USERNAME")
            ?: System.getenv("USER")
            ?: "user"
    }

    fun currentOsLabel(): String {
        val os = System.getProperty("os.name").lowercase()
        return when {
            os.contains("win") -> "win32"
            os.contains("mac") -> "darwin"
            else -> "linux"
        }
    }
}
