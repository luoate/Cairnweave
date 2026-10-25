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

export interface PiApiLike {
  on(
    event: "tool_call",
    handler: (
      event: PiToolCallEventLike,
    ) => Promise<{ block: true; reason: string } | undefined>,
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
      if (decision.allowed) return undefined;
      return {
        block: true,
        reason: decision.reason ?? "blocked by the authorized scope policy",
      };
    });
  };
}
