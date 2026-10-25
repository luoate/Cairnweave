import { describe, expect, test } from "bun:test";
import {
  TASK_PROTOCOL_VERSION,
  isTaskResult,
  isWorkerTask,
  parseTaskResultJson,
  resultErrors,
  taskErrors,
  type WorkerTask,
} from "./index";

function validTask(): WorkerTask {
  return {
    protocol: TASK_PROTOCOL_VERSION,
    taskId: "task-1",
    kind: "explore",
    projectId: "project-1",
    intentId: "intent-1",
    prompt: "advance intent-1 using the graph snapshot",
    graphSnapshotPath: "/runs/project-1/graph.yaml",
    workspace: "/runs/project-1/workspace",
    sessionDir: "/runs/project-1/session",
    resultPath: "/runs/project-1/session/result.json",
    scope: { targets: ["example.test", "10.10.0.0/24"], notes: "engagement #42" },
    softDeadlineSeconds: 780,
    hardDeadlineSeconds: 900,
  };
}

function messages(value: unknown): string {
  return taskErrors(value).join("\n");
}

describe("worker task contract", () => {
  test("accepts a complete explore task", () => {
    expect(taskErrors(validTask())).toEqual([]);
    expect(isWorkerTask(validTask())).toBe(true);
  });

  test("accepts bootstrap and reason tasks without an intent", () => {
    const { intentId: _intentId, ...rest } = validTask();
    expect(taskErrors({ ...rest, kind: "bootstrap" })).toEqual([]);
    expect(taskErrors({ ...rest, kind: "reason" })).toEqual([]);
  });

  test("requires an intent for explore and conclude", () => {
    const { intentId: _intentId, ...rest } = validTask();
    expect(messages({ ...rest, kind: "explore" })).toContain("intentId");
    expect(messages({ ...rest, kind: "conclude" })).toContain("intentId");
  });

  test("requires a resumed session only on conclude tasks", () => {
    const { intentId: _intentId, ...rest } = validTask();
    expect(taskErrors({
      ...rest,
      kind: "conclude",
      intentId: "intent-1",
      resumeSessionDir: "/runs/project-1/session",
      concludeOf: "explore",
    })).toEqual([]);
    expect(messages({ ...validTask(), resumeSessionDir: rest.sessionDir })).toContain(
      "only valid on conclude",
    );
    expect(
      messages({
        ...rest,
        kind: "conclude",
        intentId: "intent-1",
        concludeOf: "explore",
      }),
    ).toContain("conclude tasks require resumeSessionDir");
    expect(
      messages({
        ...rest,
        kind: "conclude",
        intentId: "intent-1",
        resumeSessionDir: rest.sessionDir,
      }),
    ).toContain("conclude tasks require concludeOf");
    expect(messages({ ...validTask(), concludeOf: "explore" })).toContain(
      "only valid on conclude",
    );
  });

  test("rejects an unknown kind", () => {
    expect(messages({ ...validTask(), kind: "scan" })).toContain("kind must be one of");
  });

  test("fails closed when the scope is missing or empty", () => {
    const { scope: _scope, ...withoutScope } = validTask();
    expect(messages(withoutScope)).toContain("scope must be an object");
    expect(messages({ ...validTask(), scope: { targets: [] } })).toContain(
      "scope.targets must be a non-empty array",
    );
    expect(messages({ ...validTask(), scope: { targets: [""] } })).toContain(
      "scope.targets[0] must be a non-empty string",
    );
  });

  test("requires a positive hard deadline and an earlier soft deadline", () => {
    expect(messages({ ...validTask(), hardDeadlineSeconds: 0 })).toContain(
      "hardDeadlineSeconds must be a positive integer",
    );
    expect(messages({ ...validTask(), softDeadlineSeconds: 900 })).toContain(
      "softDeadlineSeconds must be smaller",
    );
  });

  test("rejects a wrong protocol and non-objects", () => {
    expect(messages({ ...validTask(), protocol: 2 })).toContain("protocol must be 1");
    expect(messages(null)).toContain("JSON object");
    expect(messages([])).toContain("JSON object");
  });
});

describe("task result contract", () => {
  test("accepts Cairn's existing shapes", () => {
    expect(resultErrors({ accepted: true, data: { description: "confirmed" } })).toEqual([]);
    expect(resultErrors({ accepted: false, reason: "policy_refusal" })).toEqual([]);
    expect(isTaskResult({ accepted: true, data: {} })).toBe(true);
  });

  test("rejects malformed results", () => {
    expect(resultErrors({ accepted: true }).join()).toContain("data must be an object");
    expect(resultErrors({ accepted: false, reason: " " }).join()).toContain("reason");
    expect(resultErrors({ accepted: "yes", data: {} }).join()).toContain("accepted");
    expect(resultErrors("done").join()).toContain("JSON object");
  });

  test("parses strict JSON only (tolerant extraction is a separate M1 port)", () => {
    expect(parseTaskResultJson('{"accepted":true,"data":{}}')).toEqual({
      accepted: true,
      data: {},
    });
    expect(parseTaskResultJson('```json\n{"accepted":true,"data":{}}\n```')).toBeNull();
    expect(parseTaskResultJson("not json")).toBeNull();
  });
});
