package com.sunday.agent.daemon

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Minimal JSON-RPC 2.0 over NDJSON, mirroring the sundayd wire protocol
 * used by `@sunday/cli` (packages/sunday-cli/src/client.ts) and the VS Code
 * extension's socket mode.
 *
 * Every frame is one JSON object per line (`\n` terminated, no pretty
 * printing). Three frame kinds:
 * - request:    `{jsonrpc:"2.0", id, method, params}`
 * - response:   `{jsonrpc:"2.0", id, result}` or `{jsonrpc:"2.0", id, error}`
 * - notification: `{jsonrpc:"2.0", method, params}` (no id)
 *
 * Do NOT invent new methods here — this file only frames the existing
 * sundayd protocol (sunday/hello, daemon/configure, session/*, chat/*).
 */
object JsonRpc {
    const val VERSION = "2.0"
    private val gson = Gson()

    /** Protocol version spoken by this client. Must match sundayd. */
    const val PROTOCOL_VERSION = 1

    fun encodeRequest(id: Long, method: String, params: Any?): String {
        val obj = JsonObject()
        obj.addProperty("jsonrpc", VERSION)
        obj.addProperty("id", id)
        obj.addProperty("method", method)
        obj.add("params", gson.toJsonTree(params ?: emptyMap<String, Any>()))
        return gson.toJson(obj)
    }

    fun encodeNotification(method: String, params: Any?): String {
        val obj = JsonObject()
        obj.addProperty("jsonrpc", VERSION)
        obj.addProperty("method", method)
        obj.add("params", gson.toJsonTree(params ?: emptyMap<String, Any>()))
        return gson.toJson(obj)
    }

    sealed class Frame {
        data class Response(val id: Long, val result: JsonElement?, val error: RpcError?) : Frame()
        data class Notification(val method: String, val params: JsonElement?) : Frame()
        data class Invalid(val raw: String) : Frame()
    }

    data class RpcError(val code: Int, val message: String)

    fun decode(line: String): Frame {
        val el: JsonElement = try {
            JsonParser.parseString(line)
        } catch (e: Exception) {
            return Frame.Invalid(line)
        }
        if (!el.isJsonObject) return Frame.Invalid(line)
        val obj = el.asJsonObject
        if (obj.get("jsonrpc")?.asString != VERSION) return Frame.Invalid(line)
        return if (obj.has("method")) {
            Frame.Notification(
                method = obj.get("method").asString,
                params = obj.get("params"),
            )
        } else if (obj.has("id")) {
            val id = obj.get("id").asLong
            val err = obj.get("error")
            Frame.Response(
                id = id,
                result = obj.get("result"),
                error = if (err != null && err.isJsonObject) {
                    val eo = err.asJsonObject
                    RpcError(
                        code = eo.get("code")?.asInt ?: -32000,
                        message = eo.get("message")?.asString ?: "RPC error",
                    )
                } else null,
            )
        } else {
            Frame.Invalid(line)
        }
    }

    // --- chat/event payload helpers (mirrors chat.ts schemas) ---

    /** Notification params for `chat/event`. */
    data class ChatEventNotification(
        val turnId: String,
        val sessionId: String,
        val event: ChatEvent,
    )

    sealed class ChatEvent {
        data class TextDelta(val delta: String) : ChatEvent()
        data class ToolCall(val name: String, val summary: String) : ChatEvent()
        data class ToolResult(val ok: Boolean) : ChatEvent()
        data class Usage(val inputTokens: Long, val outputTokens: Long, val costUsd: Double?) : ChatEvent()
        data class TurnEnd(val finishReason: String) : ChatEvent()
        data class TurnError(val code: Int, val message: String) : ChatEvent()
        data class Unknown(val type: String) : ChatEvent()
    }

    /** Parse a `chat/event` notification's params element. Null when malformed. */
    fun parseChatEvent(params: JsonElement?): ChatEventNotification? {
        if (params == null || !params.isJsonObject) return null
        val o = params.asJsonObject
        val turnId = o.get("turnId")?.asString ?: return null
        val sessionId = o.get("sessionId")?.asString ?: return null
        val e = o.get("event")?.asJsonObject ?: return null
        val type = e.get("type")?.asString ?: return null
        val event: ChatEvent = when (type) {
            "text-delta" -> ChatEvent.TextDelta(e.get("delta")?.asString ?: "")
            "tool-call" -> {
                val call = e.get("call")?.asJsonObject
                ChatEvent.ToolCall(
                    name = call?.get("name")?.asString ?: "tool",
                    summary = call?.toString() ?: "",
                )
            }
            "tool-result" -> {
                val r = e.get("result")?.asJsonObject
                val isError = r?.get("isError")?.asBoolean ?: false
                ChatEvent.ToolResult(ok = !isError)
            }
            "usage" -> {
                val u = e.get("usage")?.asJsonObject
                ChatEvent.Usage(
                    inputTokens = u?.get("inputTokens")?.asLong ?: 0,
                    outputTokens = u?.get("outputTokens")?.asLong ?: 0,
                    costUsd = u?.get("costUsd")?.asDouble,
                )
            }
            "turn-end" -> ChatEvent.TurnEnd(e.get("finishReason")?.asString ?: "stop")
            "turn-error" -> ChatEvent.TurnError(
                code = e.get("code")?.asInt ?: -1,
                message = e.get("message")?.asString ?: "turn failed",
            )
            else -> ChatEvent.Unknown(type)
        }
        return ChatEventNotification(turnId, sessionId, event)
    }
}
