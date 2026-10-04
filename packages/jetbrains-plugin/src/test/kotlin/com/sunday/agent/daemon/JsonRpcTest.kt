package com.sunday.agent.daemon

import com.google.gson.JsonParser
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Unit tests for [JsonRpc] NDJSON framing and `chat/event` parsing.
 * These lock in wire-compatibility with sundayd: every frame shape here
 * must match what `@sunday/cli` sends and what sundayd emits.
 */
class JsonRpcTest {

    @Test
    fun `encodeRequest produces a single-line JSON-RPC request`() {
        val line = JsonRpc.encodeRequest(7, "sunday/hello", mapOf("protocolVersion" to 1))
        assertFalse(line.contains("\n"))
        val o = JsonParser.parseString(line).asJsonObject
        assertEquals("2.0", o.get("jsonrpc").asString)
        assertEquals(7, o.get("id").asInt)
        assertEquals("sunday/hello", o.get("method").asString)
        assertEquals(1, o.get("params").asJsonObject.get("protocolVersion").asInt)
    }

    @Test
    fun `encodeNotification omits id`() {
        val line = JsonRpc.encodeNotification("chat/event", mapOf("a" to 1))
        val o = JsonParser.parseString(line).asJsonObject
        assertEquals("2.0", o.get("jsonrpc").asString)
        assertFalse(o.has("id"))
        assertEquals("chat/event", o.get("method").asString)
    }

    @Test
    fun `decode routes responses by id`() {
        val frame = JsonRpc.decode("""{"jsonrpc":"2.0","id":3,"result":{"ok":true}}""")
        assertTrue(frame is JsonRpc.Frame.Response)
        val r = frame as JsonRpc.Frame.Response
        assertEquals(3, r.id)
        assertTrue(r.result!!.asJsonObject.get("ok").asBoolean)
        assertNull(r.error)
    }

    @Test
    fun `decode surfaces RPC errors`() {
        val frame = JsonRpc.decode(
            """{"jsonrpc":"2.0","id":4,"error":{"code":-32005,"message":"RunNotFound"}}"""
        )
        val r = frame as JsonRpc.Frame.Response
        assertNotNull(r.error)
        assertEquals(-32005, r.error!!.code)
        assertEquals("RunNotFound", r.error!!.message)
    }

    @Test
    fun `decode routes notifications by method`() {
        val frame = JsonRpc.decode("""{"jsonrpc":"2.0","method":"chat/event","params":{"x":1}}""")
        assertTrue(frame is JsonRpc.Frame.Notification)
        assertEquals("chat/event", (frame as JsonRpc.Frame.Notification).method)
    }

    @Test
    fun `decode rejects garbage`() {
        assertTrue(JsonRpc.decode("not json") is JsonRpc.Frame.Invalid)
        assertTrue(JsonRpc.decode("""{"jsonrpc":"1.0","id":1}""") is JsonRpc.Frame.Invalid)
        assertTrue(JsonRpc.decode("""{"foo":"bar"}""") is JsonRpc.Frame.Invalid)
    }

    @Test
    fun `parseChatEvent handles text-delta`() {
        val params = JsonParser.parseString(
            """{"turnId":"t1","sessionId":"s1","event":{"type":"text-delta","delta":"hello"}}"""
        )
        val n = JsonRpc.parseChatEvent(params)!!
        assertEquals("t1", n.turnId)
        assertEquals("s1", n.sessionId)
        val e = n.event as JsonRpc.ChatEvent.TextDelta
        assertEquals("hello", e.delta)
    }

    @Test
    fun `parseChatEvent handles turn-end and turn-error`() {
        val end = JsonRpc.parseChatEvent(
            JsonParser.parseString(
                """{"turnId":"t1","sessionId":"s1","event":{"type":"turn-end","finishReason":"stop"}}"""
            )
        )!!.event as JsonRpc.ChatEvent.TurnEnd
        assertEquals("stop", end.finishReason)

        val err = JsonRpc.parseChatEvent(
            JsonParser.parseString(
                """{"turnId":"t1","sessionId":"s1","event":{"type":"turn-error","code":1,"message":"boom"}}"""
            )
        )!!.event as JsonRpc.ChatEvent.TurnError
        assertEquals("boom", err.message)
    }

    @Test
    fun `parseChatEvent handles usage`() {
        val n = JsonRpc.parseChatEvent(
            JsonParser.parseString(
                """{"turnId":"t1","sessionId":"s1","event":{"type":"usage","usage":{"inputTokens":10,"outputTokens":20,"costUsd":0.001}}}"""
            )
        )!!
        val u = n.event as JsonRpc.ChatEvent.Usage
        assertEquals(10, u.inputTokens)
        assertEquals(20, u.outputTokens)
        assertEquals(0.001, u.costUsd!!, 1e-9)
    }

    @Test
    fun `parseChatEvent returns null for malformed params`() {
        assertNull(JsonRpc.parseChatEvent(null))
        assertNull(JsonRpc.parseChatEvent(JsonParser.parseString("""{"turnId":"t1"}""")))
        assertNull(JsonRpc.parseChatEvent(JsonParser.parseString("""{"a":1}""")))
    }

    @Test
    fun `parseChatEvent keeps unknown event types without crashing`() {
        val n = JsonRpc.parseChatEvent(
            JsonParser.parseString(
                """{"turnId":"t1","sessionId":"s1","event":{"type":"future-event","x":1}}"""
            )
        )!!
        assertTrue(n.event is JsonRpc.ChatEvent.Unknown)
    }

    @Test
    fun `protocol version matches sundayd`() {
        // Must track packages/protocol/src/version.ts PROTOCOL_VERSION.
        assertEquals(1, JsonRpc.PROTOCOL_VERSION)
    }
}
