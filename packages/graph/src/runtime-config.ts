import type { Database } from "bun:sqlite";

import { get, run } from "./db";

/**
 * Stored runtime override patch (snake_case, same sections as dispatch.yaml). The control
 * plane owns parsing and merging; the graph layer only persists the JSON text so the file
 * stays the baseline and a restart replays the same patch.
 */
export interface StoredRuntimeOverrides {
  overrides: string;
  updatedAt: string | null;
}

export function getRuntimeConfigOverrides(conn: Database): StoredRuntimeOverrides {
  const row = get<{ overrides: string; updated_at: string }>(
    conn,
    "SELECT overrides, updated_at FROM runtime_config_overrides WHERE id = 1",
  );
  if (row === null) return { overrides: "{}", updatedAt: null };
  return {
    overrides: row.overrides,
    updatedAt: row.updated_at === "" ? null : row.updated_at,
  };
}

export function setRuntimeConfigOverrides(
  conn: Database,
  overridesJson: string,
  updatedAt: string,
): void {
  run(
    conn,
    "UPDATE runtime_config_overrides SET overrides = ?, updated_at = ? WHERE id = 1",
    overridesJson,
    updatedAt,
  );
}

export function clearRuntimeConfigOverrides(conn: Database, updatedAt: string): void {
  run(
    conn,
    "UPDATE runtime_config_overrides SET overrides = '{}', updated_at = ? WHERE id = 1",
    updatedAt,
  );
}
