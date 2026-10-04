package com.sunday.agent.daemon

import com.google.gson.JsonElement
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * `SundayDaemonClient` — JSON-RPC client for the shared per-user sundayd
 * daemon (Phase 8 JetBrains frontend).
 *
 * Mirrors `DaemonClient` from `@sunday/cli` (packages/sunday-cli/src/client.ts):
 * same socket path conventions, same single-flight connect (attach to the
 * live daemon or spawn one via the lockfile mutex), same NDJSON framing,
 * same `sunday/hello` handshake. No new protocol is invented here.
 *
 * Threading: a single background reader thread pumps incoming lines and
 * dispatches responses (by id) and notifications (by method). `request()`
 * blocks the calling thread with a timeout.
 */
class DaemonDaemonClientException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

class SundayDaemonClient(
    private val socketPath: String = DaemonPaths.sharedDaemonSocketPath(),
    private val lockPath: String = DaemonPaths.sharedDaemonLockPath(),
    private val daemonCommand: List<String> = defaultDaemonCommand(),
    private val log: (String) -> Unit = {},
) {
    companion object {
        const val CLIENT_NAME = "sunday-jetbrains"
        const val CLIENT_VERSION = "0.1.0"
        const val HANDSHAKE_TIMEOUT_MS = 15_000L
        const val SPAWN_TIMEOUT_MS = 15_000L
        const val DEFAULT_REQUEST_TIMEOUT_MS = 60_000L

        /** How to launch sundayd when no daemon is listening. */
        fun defaultDaemonCommand(): List<String> {
            // Prefer an explicit install location, then PATH.
            val fromEnv = System.getenv("SUNDAY_DAEMON_PATH")?.takeIf { it.isNotBlank() }
            if (fromEnv != null) return listOf(fromEnv, "--socket")
            return listOf("sundayd", "--socket")
        }
    }

    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, Pending>()
    private val notificationHandlers = ConcurrentHashMap<String, MutableSet<(JsonElement?) -> Unit>>()
    private val closed = AtomicBoolean(false)

    @Volatile
    private var transport: DaemonTransport? = null
    private var readerThread: Thread? = null

    private data class Pending(
        val latch: CountDownLatch = CountDownLatch(1),
        @Volatile var result: JsonElement? = null,
        @Volatile var error: JsonRpc.RpcError? = null,
    )

    val isClosed: Boolean get() = closed.get()

    // --- connection ---

    /** Attach to the live daemon, spawning one (single-flight) when absent. */
    @Synchronized
    fun connect() {
        if (transport != null) return
        // 1. Try to attach.
        tryOpen()?.let {
            attach(it)
            log("attached to running daemon at $socketPath")
            hello()
            return
        }
        // 2. Single-flight spawn via lockfile mutex (wx exclusive-create).
        val lockFile = File(lockPath)
        lockFile.parentFile?.mkdirs()
        if (tryAcquireLock(lockFile)) {
            try {
                log("won spawn mutex, starting sundayd")
                spawnDaemon()
                val t = waitForSocket(SPAWN_TIMEOUT_MS)
                    ?: throw DaemonDaemonClientException("sundayd did not listen on $socketPath in time")
                attach(t)
                hello()
            } finally {
                releaseLockIfOurs(lockFile)
            }
            return
        }
        // 3. Someone else is spawning — wait for their socket.
        val deadline = System.currentTimeMillis() + SPAWN_TIMEOUT_MS
        while (true) {
            if (!isLockHolderAlive(lockFile)) {
                try { lockFile.delete() } catch (_: Exception) {}
                return connect() // retry from the top (re-entrant, synchronized)
            }
            tryOpen()?.let {
                attach(it)
                log("attached to daemon spawned by another client")
                hello()
                return
            }
            if (System.currentTimeMillis() > deadline) {
                throw DaemonDaemonClientException("timed out waiting for daemon socket at $socketPath")
            }
            Thread.sleep(100)
        }
    }

    private fun tryOpen(): DaemonTransport? {
        return try {
            if (DaemonPaths.currentPlatform() == "win32") {
                NamedPipeTransport(socketPath)
            } else {
                if (!File(socketPath).exists()) return null
                UnixSocketTransport(socketPath)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun spawnDaemon() {
        // daemonCommand already ends with "--socket"; append the path.
        val cmd = daemonCommand + socketPath
        try {
            ProcessBuilder(cmd)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            log("spawned: ${cmd.joinToString(" ")}")
        } catch (e: Exception) {
            throw DaemonDaemonClientException(
                "could not start sundayd (tried: ${cmd.joinToString(" ")}). " +
                    "Install the Sunday CLI or set SUNDAY_DAEMON_PATH.",
                e,
            )
        }
    }

    private fun waitForSocket(timeoutMs: Long): DaemonTransport? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            tryOpen()?.let { return it }
            Thread.sleep(100)
        }
        return null
    }

    private fun tryAcquireLock(lockFile: File): Boolean {
        return try {
            // Atomic exclusive-create (~ `wx`): true when we won the mutex.
            if (!lockFile.createNewFile()) return false
            // Record our PID so a successor can detect a stale lock and so
            // releaseLockIfOurs never deletes someone else's lock. Format
            // mirrors DaemonLockInfo in @sunday/protocol (daemon-paths.ts).
            val pid = ProcessHandle.current().pid()
            val startedAt = java.time.Instant.now().toString()
            lockFile.writeText(
                """{"pid":$pid,"socketPath":${jsonString(socketPath)},"startedAt":${jsonString(startedAt)},"version":1}"""
            )
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun jsonString(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun readLockPid(lockFile: File): Long? {
        return try {
            val text = lockFile.readText()
            val m = Regex(""""pid"\s*:\s*(\d+)""").find(text)
            m?.groupValues?.get(1)?.toLong()
        } catch (_: Exception) {
            null
        }
    }

    private fun releaseLockIfOurs(lockFile: File) {
        try {
            if (readLockPid(lockFile) == ProcessHandle.current().pid()) {
                lockFile.delete()
            }
        } catch (_: Exception) {}
    }

    private fun isLockHolderAlive(lockFile: File): Boolean {
        val pid = readLockPid(lockFile) ?: return false
        return ProcessHandle.of(pid).map { it.isAlive }.orElse(false)
    }

    private fun attach(t: DaemonTransport) {
        transport = t
        val thread = Thread({
            try {
                while (!closed.get()) {
                    val line = t.readLine() ?: break
                    if (line.isBlank()) continue
                    dispatch(line)
                }
            } catch (_: Exception) {
            } finally {
                close()
            }
        }, "sunday-daemon-reader")
        thread.isDaemon = true
        thread.start()
        readerThread = thread
    }

    // --- handshake ---

    private fun hello() {
        val params = mapOf(
            "protocolVersion" to JsonRpc.PROTOCOL_VERSION,
            "client" to mapOf(
                "name" to CLIENT_NAME,
                "version" to CLIENT_VERSION,
                "os" to DaemonPaths.currentOsLabel(),
            ),
        )
        val result = request("sunday/hello", params, HANDSHAKE_TIMEOUT_MS)
            ?: throw DaemonDaemonClientException("empty sunday/hello response")
        if (!result.isJsonObject) throw DaemonDaemonClientException("bad sunday/hello response")
        val o = result.asJsonObject
        val version = o.get("protocolVersion")?.asInt
            ?: throw DaemonDaemonClientException("sunday/hello missing protocolVersion")
        if (version != JsonRpc.PROTOCOL_VERSION) {
            throw DaemonDaemonClientException(
                "protocol mismatch: daemon speaks $version, plugin speaks ${JsonRpc.PROTOCOL_VERSION}"
            )
        }
        log("handshake ok (protocol v$version)")
    }

    // --- requests / notifications ---

    /** Send a JSON-RPC request; blocks until the response arrives or times out. */
    fun request(method: String, params: Any? = null, timeoutMs: Long = DEFAULT_REQUEST_TIMEOUT_MS): JsonElement? {
        val t = transport ?: throw DaemonDaemonClientException("not connected")
        if (closed.get()) throw DaemonDaemonClientException("client closed")
        val id = nextId.getAndIncrement()
        val pending = Pending()
        this.pending[id] = pending
        try {
            t.writeLine(JsonRpc.encodeRequest(id, method, params))
        } catch (e: Exception) {
            this.pending.remove(id)
            throw DaemonDaemonClientException("write failed: ${e.message}", e)
        }
        val ok = pending.latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        this.pending.remove(id)
        if (!ok) throw DaemonDaemonClientException("request '$method' timed out after ${timeoutMs}ms")
        pending.error?.let { throw DaemonDaemonClientException("RPC error ${it.code}: ${it.message}") }
        return pending.result
    }

    /** Subscribe to a server→client notification. Returns an unsubscribe fn. */
    fun onNotification(method: String, handler: (JsonElement?) -> Unit): () -> Unit {
        val set = notificationHandlers.computeIfAbsent(method) { mutableSetOf() }
        set.add(handler)
        return { set.remove(handler) }
    }

    private fun dispatch(line: String) {
        when (val frame = JsonRpc.decode(line)) {
            is JsonRpc.Frame.Response -> {
                val p = pending[frame.id] ?: return
                p.result = frame.result
                p.error = frame.error
                p.latch.countDown()
            }
            is JsonRpc.Frame.Notification -> {
                notificationHandlers[frame.method]?.toList()?.forEach { h ->
                    try { h(frame.params) } catch (_: Exception) {}
                }
            }
            is JsonRpc.Frame.Invalid -> {
                // ignore malformed lines, like the CLI does
            }
        }
    }

    /** Detach from the daemon. Never shuts it down (shared per-user daemon). */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        pending.values.forEach { it.latch.countDown() }
        pending.clear()
        try { transport?.close() } catch (_: Exception) {}
        transport = null
    }
}
