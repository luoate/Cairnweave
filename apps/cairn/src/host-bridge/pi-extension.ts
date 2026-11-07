/**
 * Minimal pi extension adapter for the Host Bridge.
 *
 * Structural typing keeps the app from importing pi's tool event types (and from pinning
 * them); the vendored agent passes its real extension API to this factory at runtime.
 */

import type { HostBridge } from "./bridge";

export interface PiToolCallEventLike {
  toolName?: unknown;
  input?: unknown;
}

export interface PiMessageLike {
  customType?: string;
  content: Array<{ type: "text"; text: string }>;
  display?: boolean;
  details?: Record<string, unknown>;
}

export interface PiApiLike {
  on(
    event: "tool_call",
    handler: (
      event: PiToolCallEventLike,
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): unknown;
  /**
   * Optional: the real pi API can inject a message into the running conversation. The
   * bridge uses it once, at 80% of the tool budget, to ask the worker to start writing
   * its findings. Without it the warning only reaches the model as a block reason.
   */
  sendMessage?(
    message: PiMessageLike,
    options?: { deliverAs?: "steer" | "nextTurn" },
  ): unknown;
}

/** Returns an extension factory accepted by `createSolverSession({ extensions })`. */
export function hostBridgeExtension(
  bridge: HostBridge,
): (pi: PiApiLike) => void {
  return (pi: PiApiLike): void => {
    pi.on("tool_call", async (event) => {
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      const decision = bridge.checkToolCall(toolName, event.input);
      if (decision.event === "tool_budget_warning") {
        pi.sendMessage?.(
          {
            customType: "cairn-tool-budget-warning",
            content: [
              {
                type: "text",
                text:
                  "工具预算已用掉约 80%。停止新的探测，把已经确认的结论和证据写进本任务的产物目录，" +
                  "剩余调用将只允许写产物文件。",
              },
            ],
            display: false,
            details: { tool: decision.tool },
          },
          { deliverAs: "nextTurn" },
        );
      }
      if (decision.allowed) return undefined;
      return {
        block: true,
        reason: decision.reason ?? "blocked by the authorized scope policy",
      };
    });
  };
}
