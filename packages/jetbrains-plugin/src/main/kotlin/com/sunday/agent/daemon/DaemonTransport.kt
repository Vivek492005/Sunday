package com.sunday.agent.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.RandomAccessFile
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.net.UnixDomainSocketAddress
import java.nio.charset.StandardCharsets
import java.nio.file.Path

/**
 * Line-oriented transport over the per-user sundayd socket.
 *
 * - POSIX: unix domain socket at `~/.sunday/sundayd.sock`
 *   (Java 16+: `UnixDomainSocketAddress`).
 * - Windows: named pipe `\\.\pipe\sundayd-<user>` opened as a
 *   `RandomAccessFile` in "rw" mode.
 *
 * NDJSON framing: one JSON object per `\n`-terminated line.
 */
interface DaemonTransport : Closeable {
    fun writeLine(line: String)
    /** Blocks until a line is available; null on clean EOF. */
    fun readLine(): String?
}

class UnixSocketTransport(socketPath: String) : DaemonTransport {
    private val channel: SocketChannel =
        SocketChannel.open(UnixDomainSocketAddress.of(Path.of(socketPath)))
    private val reader = BufferedReader(
        InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8)
    )
    private val writer = BufferedWriter(
        OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
    )

    override fun writeLine(line: String) {
        writer.write(line)
        writer.write("\n")
        writer.flush()
    }

    override fun readLine(): String? = reader.readLine()

    override fun close() {
        try { reader.close() } catch (_: Exception) {}
        try { writer.close() } catch (_: Exception) {}
        try { channel.close() } catch (_: Exception) {}
    }
}

class NamedPipeTransport(pipePath: String) : DaemonTransport {
    private val raf = RandomAccessFile(pipePath, "rw")
    private val buf = StringBuilder()

    override fun writeLine(line: String) {
        val bytes = (line + "\n").toByteArray(StandardCharsets.UTF_8)
        synchronized(raf) { raf.write(bytes) }
    }

    override fun readLine(): String? {
        val lineBytes = mutableListOf<Byte>()
        while (true) {
            val b: Int = try {
                synchronized(raf) { raf.read() }
            } catch (_: Exception) {
                return if (lineBytes.isEmpty()) null else decode(lineBytes)
            }
            if (b == -1) {
                // No data yet on a pipe read — brief backoff instead of
                // busy-spinning; EOF mid-line still returns what we have.
                if (lineBytes.isEmpty()) {
                    try { Thread.sleep(10) } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return null
                    }
                    continue
                }
                return decode(lineBytes)
            }
            if (b == '\n'.code) return decode(lineBytes)
            if (b != '\r'.code) lineBytes.add(b.toByte())
        }
    }

    private fun decode(bytes: List<Byte>): String =
        String(bytes.toByteArray(), StandardCharsets.UTF_8)

    override fun close() {
        try { raf.close() } catch (_: Exception) {}
    }
}
