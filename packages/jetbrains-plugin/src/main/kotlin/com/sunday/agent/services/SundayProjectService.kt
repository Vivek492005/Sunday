package com.sunday.agent.services

import com.google.gson.JsonElement
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.sunday.agent.daemon.DaemonDaemonClientException
import com.sunday.agent.daemon.JsonRpc
import com.sunday.agent.daemon.SundayDaemonClient

/**
 * Project-level service owning the sundayd connection and the active chat
 * session (mirrors what the VS Code extension keeps per window).
 *
 * Lifecycle: created per open project, disposed with it. The daemon itself
 * is per-user and shared — closing here only detaches.
 */
@Service(Service.Level.PROJECT)
class SundayProjectService(private val project: Project) : Disposable {

    private val lock = Any()
    private var client: SundayDaemonClient? = null
    private var sessionId: String? = null
    private var configuredRoot: String? = null

    /** Listener for chat stream events; invoked on the reader thread. */
    interface ChatListener {
        fun onTextDelta(delta: String)
        fun onToolCall(name: String)
        fun onTurnEnd(finishReason: String)
        fun onTurnError(message: String)
        fun onUsage(inputTokens: Long, outputTokens: Long, costUsd: Double?)
    }

    private val chatListeners = mutableSetOf<ChatListener>()

    fun addChatListener(l: ChatListener) = synchronized(lock) { chatListeners.add(l) }
    fun removeChatListener(l: ChatListener) = synchronized(lock) { chatListeners.remove(l) }

    private fun listeners(): List<ChatListener> = synchronized(lock) { chatListeners.toList() }

    @Volatile
    private var activeTurnId: String? = null

    /** Connect to sundayd (attaching or spawning), then configure the workspace. */
    fun ensureConnected(): SundayDaemonClient = synchronized(lock) {
        client?.let { return it }
        val c = SundayDaemonClient(log = { /* TODO: route to IDE log */ })
        c.connect()
        val root = project.basePath ?: System.getProperty("user.home")
        if (root != configuredRoot) {
            c.request("daemon/configure", mapOf("workspaceRoot" to root, "trusted" to true))
            configuredRoot = root
        }
        // Subscribe once per client for chat events.
        c.onNotification("chat/event") { params -> onChatEvent(params) }
        client = c
        return c
    }

    fun isConnected(): Boolean = synchronized(lock) { client?.isClosed == false }

    /** Send a chat message; streams back through the registered listeners. */
    fun sendMessage(message: String, model: String? = null) {
        val c = ensureConnected()
        var sid = synchronized(lock) { sessionId }
        if (sid == null) {
            val root = project.basePath ?: System.getProperty("user.home")
            val result = c.request(
                "session/create",
                mapOf("title" to message.take(60), "cwd" to root),
            )?.asJsonObject
            sid = result?.get("session")?.asJsonObject?.get("id")?.asString
                ?: throw DaemonDaemonClientException("session/create returned no id")
            synchronized(lock) { sessionId = sid }
        }
        val params = mutableMapOf<String, Any>("sessionId" to sid, "message" to message)
        if (model != null) params["model"] = model
        val res = c.request("chat/send", params)?.asJsonObject
        val turnId = res?.get("turnId")?.asString
            ?: throw DaemonDaemonClientException("chat/send returned no turnId")
        activeTurnId = turnId
    }

    fun cancelActiveTurn() {
        val turnId = activeTurnId ?: return
        try {
            ensureConnected().request("chat/cancel", mapOf("turnId" to turnId), 10_000)
        } catch (_: Exception) {
        } finally {
            activeTurnId = null
        }
    }

    private fun onChatEvent(params: JsonElement?) {
        val n = JsonRpc.parseChatEvent(params) ?: return
        val mySession = synchronized(lock) { sessionId } ?: return
        if (n.sessionId != mySession) return
        val myTurn = activeTurnId
        if (myTurn != null && n.turnId != myTurn) return
        when (val e = n.event) {
            is JsonRpc.ChatEvent.TextDelta -> listeners().forEach { it.onTextDelta(e.delta) }
            is JsonRpc.ChatEvent.ToolCall -> listeners().forEach { it.onToolCall(e.name) }
            is JsonRpc.ChatEvent.ToolResult -> { /* quiet; deltas carry the narrative */ }
            is JsonRpc.ChatEvent.Usage -> listeners().forEach { it.onUsage(e.inputTokens, e.outputTokens, e.costUsd) }
            is JsonRpc.ChatEvent.TurnEnd -> {
                activeTurnId = null
                listeners().forEach { it.onTurnEnd(e.finishReason) }
            }
            is JsonRpc.ChatEvent.TurnError -> {
                activeTurnId = null
                listeners().forEach { it.onTurnError(e.message) }
            }
            is JsonRpc.ChatEvent.Unknown -> { /* ignore */ }
        }
    }

    override fun dispose() {
        try { client?.close() } catch (_: Exception) {}
        client = null
    }

    companion object {
        fun getInstance(project: Project): SundayProjectService =
            project.getService(SundayProjectService::class.java)
    }
}
