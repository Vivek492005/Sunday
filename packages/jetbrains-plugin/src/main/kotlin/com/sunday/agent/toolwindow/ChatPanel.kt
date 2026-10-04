package com.sunday.agent.toolwindow

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.sunday.agent.services.SundayProjectService
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextPane
import javax.swing.SwingUtilities
import javax.swing.text.BadLocationException

/**
 * Sunday chat panel — the JetBrains counterpart of the VS Code extension's
 * chat webview and the `sunday chat` CLI.
 *
 * Streams `chat/event` notifications from the shared sundayd daemon:
 * text deltas append live, tool calls show as status lines, turn-end
 * re-enables the input.
 */
class ChatPanel(private val project: Project) : JPanel(BorderLayout()), SundayProjectService.ChatListener, Disposable {

    private val transcript = JTextPane().apply {
        isEditable = false
        contentType = "text/plain"
    }
    private val input = JBTextArea(3, 40).apply {
        lineWrap = true
        wrapStyleWord = true
    }
    private val sendButton = JButton("Send")
    private val statusLabel = JLabel("Not connected")

    private val service: SundayProjectService = SundayProjectService.getInstance(project)

    init {
        val scroll = JBScrollPane(transcript).apply {
            preferredSize = Dimension(360, 400)
        }
        add(scroll, BorderLayout.CENTER)

        val bottom = JPanel(BorderLayout())
        val inputScroll = JBScrollPane(input).apply {
            preferredSize = Dimension(360, 80)
        }
        bottom.add(inputScroll, BorderLayout.CENTER)

        val bar = JPanel(BorderLayout())
        bar.add(statusLabel, BorderLayout.WEST)
        bar.add(sendButton, BorderLayout.EAST)
        bottom.add(bar, BorderLayout.SOUTH)
        add(bottom, BorderLayout.SOUTH)

        sendButton.addActionListener { sendCurrentInput() }
        input.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                // Enter sends, Shift+Enter inserts a newline.
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    sendCurrentInput()
                }
            }
        })

        service.addChatListener(this)
    }

    /** Programmatic entry-point used by actions (e.g. send selection). */
    fun sendPrompt(prompt: String) {
        appendSystem("You", prompt)
        setBusy(true)
        Thread({
            try {
                service.sendMessage(prompt)
                runOnEdt { statusLabel.text = "Streaming…" }
            } catch (e: Exception) {
                runOnEdt {
                    appendSystem("Error", e.message ?: "failed to send")
                    setBusy(false)
                }
            }
        }, "sunday-send").start()
    }

    private fun sendCurrentInput() {
        val text = input.text.trim()
        if (text.isEmpty()) return
        input.text = ""
        sendPrompt(text)
    }

    private fun setBusy(busy: Boolean) {
        sendButton.isEnabled = !busy
        input.isEnabled = !busy
        if (!busy) statusLabel.text = if (service.isConnected()) "Connected" else "Not connected"
    }

    private fun appendText(text: String) {
        runOnEdt {
            try {
                val doc = transcript.styledDocument
                doc.insertString(doc.length, text, null)
                transcript.caretPosition = doc.length
            } catch (_: BadLocationException) {}
        }
    }

    private fun appendSystem(role: String, text: String) {
        appendText("\n[$role]\n$text\n")
    }

    private fun runOnEdt(action: () -> Unit) {
        if (SwingUtilities.isEventDispatchThread()) action()
        else SwingUtilities.invokeLater(action)
    }

    // --- SundayProjectService.ChatListener (called on the reader thread) ---

    override fun onTextDelta(delta: String) = appendText(delta)

    override fun onToolCall(name: String) {
        appendText("\n[tool] $name\n")
    }

    override fun onTurnEnd(finishReason: String) {
        runOnEdt {
            statusLabel.text = "Connected"
            setBusy(false)
            appendText("\n")
        }
    }

    override fun onTurnError(message: String) {
        runOnEdt {
            appendSystem("Error", message)
            setBusy(false)
        }
    }

    override fun onUsage(inputTokens: Long, outputTokens: Long, costUsd: Double?) {
        val cost = if (costUsd != null) " cost=\$${"%.4f".format(costUsd)}" else ""
        appendText("\n[usage] in=$inputTokens out=$outputTokens$cost\n")
    }

    fun getComponent(): JComponent = this

    override fun dispose() {
        service.removeChatListener(this)
    }
}
