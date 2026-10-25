import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, run, type CairnDatabase } from "./db";
import { exportProjectTimeline, exportProjectYaml } from "./export";
import { setUtcNowSource } from "./services";

// The goldens were produced by PyYAML on a UTC clock.
process.env.TZ = "UTC";

interface GoldenFact {
  id: string;
  description: string;
}

interface GoldenHint {
  id: string;
  content: string;
  creator: string;
  created_at: string;
}

interface GoldenIntent {
  id: string;
  from: string[];
  to: string | null;
  description: string;
  creator: string;
  worker: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  concluded_at: string | null;
}

interface ExportGolden {
  timezone: string;
  project: { id: string; title: string; created_at: string };
  facts: GoldenFact[];
  hints: GoldenHint[];
  intents: GoldenIntent[];
  expected: { yaml: string; timeline: string };
}

const golden = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "testdata", "export.golden.json"), "utf8"),
) as ExportGolden;

let directory: string;
let db: CairnDatabase;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-export-"));
  db = configureDatabase(join(directory, "cairn.db"));
  db.withConn((conn) => {
    run(
      conn,
      "INSERT INTO projects (id, title, status, bootstrap_enabled, created_at) VALUES (?, ?, 'active', 1, ?)",
      golden.project.id,
      golden.project.title,
      golden.project.created_at,
    );
    for (const fact of golden.facts) {
      run(
        conn,
        "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
        fact.id,
        golden.project.id,
        fact.description,
      );
    }
    for (const hint of golden.hints) {
      run(
        conn,
        "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
        hint.id,
        golden.project.id,
        hint.content,
        hint.creator,
        hint.created_at,
      );
    }
    for (const intent of golden.intents) {
      run(
        conn,
        "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        intent.id,
        golden.project.id,
        intent.to,
        intent.description,
        intent.creator,
        intent.worker,
        intent.last_heartbeat_at,
        intent.created_at,
        intent.concluded_at,
      );
      for (const source of intent.from) {
        run(
          conn,
          "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
          intent.id,
          golden.project.id,
          source,
        );
      }
    }
  });
  // Hold the clock inside the 500-minute lease window used for the fixture.
  setUtcNowSource(() => "2026-01-02T03:40:00Z");
});

afterAll(() => {
  setUtcNowSource(null);
  rmSync(directory, { recursive: true, force: true });
});

describe("export parity with Python Cairn", () => {
  test("YAML matches PyYAML byte for byte", () => {
    const actual = db.withConn((conn) => exportProjectYaml(conn, golden.project.id));
    expect(actual).toBe(golden.expected.yaml);
  });

  test("timeline matches the Python renderer", () => {
    const actual = db.withConn((conn) =>
      exportProjectTimeline(conn, golden.project.id),
    );
    expect(actual).toBe(golden.expected.timeline);
  });
});
