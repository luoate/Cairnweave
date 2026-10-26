import { describe, expect, test } from "bun:test";

import { AuditTokenRegistry } from "./tokens";

describe("audit stream tokens", () => {
  test("binds a token to its project and task", () => {
    const registry = new AuditTokenRegistry();
    const token = registry.register("proj-1", "explore-aaaaaaaaaaaa");

    expect(registry.authenticate(token, "proj-1", "explore-aaaaaaaaaaaa")).toBe(true);
    expect(registry.authenticate(token, "proj-2", "explore-aaaaaaaaaaaa")).toBe(false);
    expect(registry.authenticate(token, "proj-1", "explore-bbbbbbbbbbbb")).toBe(false);
    expect(registry.authenticate("cairn_audit_wrong", "proj-1", "explore-aaaaaaaaaaaa")).toBe(
      false,
    );
    expect(registry.authenticate("", "proj-1", "explore-aaaaaaaaaaaa")).toBe(false);
  });

  test("revokes and replaces tokens per task", () => {
    const registry = new AuditTokenRegistry();
    const first = registry.register("proj-1", "explore-aaaaaaaaaaaa");
    const second = registry.register("proj-1", "explore-aaaaaaaaaaaa");

    expect(second).not.toBe(first);
    expect(registry.authenticate(first, "proj-1", "explore-aaaaaaaaaaaa")).toBe(false);
    expect(registry.authenticate(second, "proj-1", "explore-aaaaaaaaaaaa")).toBe(true);
    expect(registry.size).toBe(1);

    registry.revoke("proj-1", "explore-aaaaaaaaaaaa");
    expect(registry.size).toBe(0);
    expect(registry.authenticate(second, "proj-1", "explore-aaaaaaaaaaaa")).toBe(false);
  });

  test("keeps separate tasks independent", () => {
    const registry = new AuditTokenRegistry();
    const one = registry.register("proj-1", "explore-aaaaaaaaaaaa");
    const two = registry.register("proj-1", "explore-bbbbbbbbbbbb");

    expect(registry.authenticate(one, "proj-1", "explore-aaaaaaaaaaaa")).toBe(true);
    expect(registry.authenticate(two, "proj-1", "explore-bbbbbbbbbbbb")).toBe(true);
    expect(registry.authenticate(one, "proj-1", "explore-bbbbbbbbbbbb")).toBe(false);
    expect(registry.authenticate(two, "proj-1", "explore-aaaaaaaaaaaa")).toBe(false);
  });
});
