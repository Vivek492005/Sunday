package com.sunday.agent.daemon

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Unit tests for [DaemonPaths] — the well-known per-user socket conventions.
 * Must stay byte-identical in behavior to `@sunday/protocol`'s
 * `daemon-paths.ts`, or the plugin will not find the shared daemon.
 */
class DaemonPathsTest {

    @Test
    fun `posix socket lives under dot-sunday`() {
        val p = DaemonPaths.sharedDaemonSocketPath(
            platform = "linux",
            homeDir = "/home/tester",
        )
        assertEquals("/home/tester/.sunday/sundayd.sock", p)
    }

    @Test
    fun `darwin uses the posix socket too`() {
        val p = DaemonPaths.sharedDaemonSocketPath(
            platform = "darwin",
            homeDir = "/Users/tester",
        )
        assertEquals("/Users/tester/.sunday/sundayd.sock", p)
    }

    @Test
    fun `windows uses a named pipe with sanitized username`() {
        val p = DaemonPaths.sharedDaemonSocketPath(
            platform = "win32",
            username = "Test User!@#",
        )
        assertEquals("""\\.\pipe\sundayd-Test_User___""", p)
    }

    @Test
    fun `windows falls back to user when username is empty`() {
        val p = DaemonPaths.sharedDaemonSocketPath(platform = "win32", username = "")
        assertEquals("""\\.\pipe\sundayd-user""", p)
    }

    @Test
    fun `sanitizePipeUser keeps safe chars and truncates`() {
        assertEquals("alice.bob-smith_1", DaemonPaths.sanitizePipeUser("alice.bob-smith_1"))
        assertEquals("a_b", DaemonPaths.sanitizePipeUser("a/b"))
        assertEquals("user", DaemonPaths.sanitizePipeUser("!!!"))
        val long = "x".repeat(100)
        assertEquals(64, DaemonPaths.sanitizePipeUser(long).length)
    }

    @Test
    fun `lock path is shared on all platforms`() {
        assertEquals(
            "/home/tester/.sunday/sundayd.lock",
            DaemonPaths.sharedDaemonLockPath(homeDir = "/home/tester"),
        )
    }

    @Test
    fun `current platform detection never returns blank`() {
        assertTrue(DaemonPaths.currentPlatform().isNotBlank())
        assertTrue(DaemonPaths.currentOsLabel().isNotBlank())
        assertTrue(DaemonPaths.currentUsername().isNotBlank())
    }
}
