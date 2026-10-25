import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { PromptSessionExtensionLike } from "../../../config/index"
import { buildObserverExtensionAppendPrompt } from "../challenge-observer/observer-loop"
import { cairnObserverAgentTools } from "../challenge-observer/tools"
import { attachCairnObserverLoop, type CairnObserverLoopDeps } from "./loop"
import type { CairnObserverHandle, CairnObserverOptions } from "./types"

const CAIRN_OBSERVER_APPEND_PROMPT = `## Cairn Observer

- 看板是**项目级**的（跨任务持久），位于当前项目的 \`.cairn/board\`；其他任务可能同时读写它。
- 你只有 \`memory_list\`、\`idea_list\`、\`idea_search\` 三个只读工具；写看板由 observer sidecar 独占。
- 开始新方向前先看 \`idea_list\` / \`idea_search\`；怀疑遗忘已验证结论时看 \`memory_list\`。
- 看板内容是候选假设与 durable memory，不是结论；最终仍以你的实测结果和 JSON 输出为准。`

export interface CairnObserverExtension {
    extension: PromptSessionExtensionLike
    handle: CairnObserverHandle
}

/**
 * Cairn-native replacement for `challengeObserverExtension`.
 *
 * There is deliberately no challenge-mode gate, no continuation hook, and no hint
 * trigger: the worker is one-shot and must always return one task result.
 */
export function cairnObserverExtension(
    options: CairnObserverOptions,
    deps: CairnObserverLoopDeps = {},
): CairnObserverExtension {
    let handle: CairnObserverHandle | undefined

    const factory: ExtensionFactory = (pi) => {
        for (const tool of cairnObserverAgentTools) {
            pi.registerTool(tool)
        }
        handle = attachCairnObserverLoop(pi, options, deps)
    }

    return {
        extension: {
            factory,
            appendSystemPrompt: `${buildObserverExtensionAppendPrompt()}\n\n${CAIRN_OBSERVER_APPEND_PROMPT}`,
        },
        handle: {
            async flush(timeoutMs?: number): Promise<void> {
                await handle?.flush(timeoutMs)
            },
        },
    }
}
