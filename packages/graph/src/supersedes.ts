/**
 * Sidecar supersede edges (M15b).
 *
 * The graph stays append-only: a fact is never rewritten or deleted. A newer fact records
 * the older fact ids it replaces in `fact_meta.supersedes`, and every read-only summary
 * derives the reverse `superseded_by` edge from those rows. The control plane validates
 * the edge when a proposal is applied; this module also tolerates legacy/duplicate rows by
 * choosing the newest replacement deterministically.
 */

import type { Database } from "bun:sqlite";

import { all } from "./db";
import type { FactSupersession, ProjectSupersedeSummary } from "./models";
import { getProjectOr404 } from "./services";

export const MAX_SUPERSEDES = 20;
export const MAX_SUPERSEDE_ID_CHARS = 64;

interface SupersedeRow {
  fact_id: string;
  supersedes: string;
  created_at: string;
}

interface FactDescriptionRow {
  id: string;
  description: string;
}

interface FactCountRow {
  total: number;
}

export function parseSupersededIds(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item !== "")
      : [];
  } catch {
    return [];
  }
}

/** All direct edges, with duplicate targets collapsed to the newest replacement. */
export function listFactSupersessions(
  conn: Database,
  projectId: string,
): FactSupersession[] {
  getProjectOr404(conn, projectId);
  const facts = new Map(
    all<FactDescriptionRow>(
      conn,
      "SELECT id, description FROM facts WHERE project_id = ?",
      projectId,
    ).map((row) => [row.id, row.description]),
  );
  const rows = all<SupersedeRow>(
    conn,
    "SELECT fact_id, supersedes, created_at FROM fact_meta WHERE project_id = ?",
    projectId,
  );

  const edges = new Map<string, FactSupersession>();
  for (const row of rows) {
    if (!facts.has(row.fact_id)) continue;
    for (const target of new Set(parseSupersededIds(row.supersedes))) {
      if (target === row.fact_id || !facts.has(target)) continue;
      const edge: FactSupersession = {
        fact_id: target,
        description: facts.get(target)!,
        superseded_by: row.fact_id,
        superseded_by_description: facts.get(row.fact_id)!,
        created_at: row.created_at,
      };
      const prior = edges.get(target);
      if (
        prior === undefined ||
        edge.created_at > prior.created_at ||
        (edge.created_at === prior.created_at &&
          edge.superseded_by > prior.superseded_by)
      ) {
        edges.set(target, edge);
      }
    }
  }
  return [...edges.values()].sort((left, right) =>
    left.fact_id.localeCompare(right.fact_id),
  );
}

export function buildProjectSupersedeSummary(
  conn: Database,
  projectId: string,
): ProjectSupersedeSummary {
  getProjectOr404(conn, projectId);
  const total =
    all<FactCountRow>(
      conn,
      "SELECT COUNT(*) AS total FROM facts WHERE project_id = ?",
      projectId,
    )[0]?.total ?? 0;
  const supersessions = listFactSupersessions(conn, projectId);
  return {
    project_id: projectId,
    facts: {
      total,
      current: total - supersessions.length,
      superseded: supersessions.length,
    },
    supersessions,
  };
}

/** The effective replacement for one fact, if any. */
export function findSupersedingFact(
  conn: Database,
  projectId: string,
  factId: string,
): string | null {
  return (
    listFactSupersessions(conn, projectId).find((edge) => edge.fact_id === factId)
      ?.superseded_by ?? null
  );
}
