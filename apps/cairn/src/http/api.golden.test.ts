import { afterAll, beforeAll, describe, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  setUtcNowSource,
  type CairnDatabase,
  type SqlValue,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

process.env.TZ = "UTC";

interface ApiStep {
  method?: string;
  path?: string;
  status?: number;
  content_type?: string | null;
  body?: string;
  compare?: "full" | "status";
  json?: unknown;
  sql?: string;
  params?: SqlValue[];
}

interface ApiGolden {
  timezone: string;
  clock_start: string;
  clock_step_seconds: number;
  steps: ApiStep[];
}

const golden = JSON.parse(
  readFileSync(join(import.meta.dir, "testdata", "api.golden.json"), "utf8"),
) as ApiGolden;

class Clock {
  private current: number;

  constructor(start: string, private readonly stepSeconds: number) {
    this.current = Date.parse(start);
  }

  next = (): string => {
    const value = new Date(this.current).toISOString().replace(/\.\d{3}Z$/, "Z");
    this.current += this.stepSeconds * 1000;
    return value;
  };
}

let directory: string;
let db: CairnDatabase;
let api: Api;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-golden-"));
  db = configureDatabase(join(directory, "cairn.db"));
  const clock = new Clock(golden.clock_start, golden.clock_step_seconds);
  setUtcNowSource(clock.next);
  api = createApi({ db });
});

afterAll(() => {
  setUtcNowSource(null);
  rmSync(directory, { recursive: true, force: true });
});

describe("HTTP API parity with Python Cairn", () => {
  test("replays the Python request sequence", async () => {
    for (let index = 0; index < golden.steps.length; index += 1) {
      const step = golden.steps[index]!;
      const label = `${index}: ${step.method ?? "SQL"} ${step.path ?? step.sql ?? ""}`;

      if (step.sql !== undefined) {
        db.withConn((conn) => {
          conn.query(step.sql!).run(...(step.params ?? []));
        });
        continue;
      }

      const init: RequestInit = { method: step.method! };
      if (Object.prototype.hasOwnProperty.call(step, "json")) {
        init.body = JSON.stringify(step.json);
        init.headers = { "content-type": "application/json" };
      }
      const response = await api.handle(
        new Request(`http://localhost${step.path!}`, init),
      );
      const body = await response.text();

      if (response.status !== step.status) {
        throw new Error(`${label}: status ${response.status}, expected ${step.status}`);
      }
      if (step.compare === "full") {
        const contentType = response.headers.get("content-type");
        if (contentType !== (step.content_type ?? null)) {
          throw new Error(
            `${label}: content-type ${contentType}, expected ${step.content_type}`,
          );
        }
        if (body !== (step.body ?? "")) {
          throw new Error(
            `${label}: body mismatch\n--- actual ---\n${body}\n--- expected ---\n${step.body}`,
          );
        }
      }
    }
  });
});
