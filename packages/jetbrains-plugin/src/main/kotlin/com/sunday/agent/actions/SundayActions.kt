package com.sunday.agent.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Opens the Sunday chat tool window (mirrors `sunday.manager.open` /
 * the chat view in the VS Code extension).
 */
class OpenSundayChatAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Sunday") ?: return
        toolWindow.show()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}

/**
 * Sends the current editor selection (or the line under the caret) to
 * Sunday chat as a quoted code block.
 */
class SendSelectionToSundayAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor: Editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selection = editor.selectionModel.selectedText
            ?: editor.document.getText(
                com.intellij.openapi.util.TextRange(
                    editor.document.getLineStartOffset(editor.caretModel.logicalPosition.line),
                    editor.document.getLineEndOffset(editor.caretModel.logicalPosition.line),
                )
            )
        if (selection.isBlank()) return
        val language = e.getData(CommonDataKeys.PSI_FILE)?.language?.id?.lowercase() ?: ""
        val prompt = "```$language\n$selection\n```"
        openChatAndSend(project, prompt)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible =
            e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }
}

/**
 * Asks Sunday to explain the selected code (mirrors the VS Code
 * extension's "Explain" code action).
 */
class ExplainCodeAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor: Editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val selection = editor.selectionModel.selectedText ?: return
        if (selection.isBlank()) return
        val language = e.getData(CommonDataKeys.PSI_FILE)?.language?.id?.lowercase() ?: ""
        val prompt = "Explain this code:\n```$language\n$selection\n```"
        openChatAndSend(project, prompt)
    }

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible =
            e.project != null && editor?.selectionModel?.hasSelection() == true
    }
}

private fun openChatAndSend(
    project: com.intellij.openapi.project.Project,
    prompt: String,
) {
    val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("Sunday") ?: return
    toolWindow.show {
        val content = toolWindow.contentManager.getContent(0) ?: return@show
        val panel = content.component as? com.sunday.agent.toolwindow.ChatPanel ?: return@show
        panel.sendPrompt(prompt)
    }
}
