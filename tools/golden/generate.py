"""Generate parity goldens from the Python Cairn implementation.

Run this with the golden virtualenv (see README in this directory), from a directory other
than the Cairn checkout, and pass the checkout path explicitly:

    TZ=UTC .venv/Scripts/python -I generate.py --cairn-root ../../../Cairn-main

The script only reads the Cairn sources; it writes fixtures into the merged repository.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

NOT_SET = object()


class Clock:
    """Deterministic UTC clock: one minute per call, starting at a fixed instant."""

    def __init__(self) -> None:
        self.current = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)

    def __call__(self) -> str:
        value = self.current
        self.current += timedelta(minutes=1)
        return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cairn-root",
        required=True,
        help="path to the Cairn-main checkout",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="merged repository root (defaults to two levels above this script)",
    )
    args = parser.parse_args()

    cairn_root = Path(args.cairn_root).resolve()
    out_root = (
        Path(args.out).resolve()
        if args.out
        else Path(__file__).resolve().parents[2]
    )

    sys.path.insert(0, str(cairn_root / "cairn" / "src"))

    from cairn.server import services as services_module

    clock = Clock()
    services_module.utcnow = clock  # type: ignore[assignment]

    from cairn.server import db
    from cairn.server.app import app
    from cairn.server.routers.export import _export_timeline, _export_yaml

    workdir = Path(tempfile.mkdtemp(prefix="cairn-golden-"))
    db._db_path = None  # type: ignore[attr-defined]
    db.configure(workdir / "cairn.db")

    from fastapi.testclient import TestClient

    steps: list[dict[str, Any]] = []

    with TestClient(app) as client:

        def request(
            method: str,
            path: str,
            json_body: Any = NOT_SET,
        ) -> None:
            kwargs: dict[str, Any] = {}
            if json_body is not NOT_SET:
                kwargs["json"] = json_body
            response = client.request(method, path, **kwargs)
            step: dict[str, Any] = {
                "method": method,
                "path": path,
                "status": response.status_code,
                "content_type": response.headers.get("content-type"),
                "body": response.text,
                "compare": "status" if response.status_code == 422 else "full",
            }
            if json_body is not NOT_SET:
                step["json"] = json_body
            steps.append(step)

        def sql(statement: str, params: tuple[Any, ...] = ()) -> None:
            with db.get_conn() as conn:
                conn.execute(statement, params)
            steps.append({"sql": statement, "params": list(params)})

        # Settings first: a long lease timeout keeps later steps from expiring early.
        request("PUT", "/settings", {"intent_timeout": 500, "reason_timeout": 500})
        request("GET", "/settings")
        request("PUT", "/settings", {"intent_timeout": 4, "reason_timeout": 500})
        request("PUT", "/settings", {"intent_timeout": 500, "reason_timeout": 500})

        # Projects.
        request(
            "POST",
            "/projects",
            {
                "title": "test",
                "origin": "starting point",
                "goal": "finish",
                "hints": [{"content": "initial clue", "creator": "human"}],
            },
        )
        request(
            "POST",
            "/projects",
            {
                "title": "no bootstrap",
                "origin": "start",
                "goal": "finish",
                "bootstrap_enabled": False,
            },
        )
        request(
            "POST",
            "/projects",
            {
                "title": "invalid bootstrap",
                "origin": "start",
                "goal": "finish",
                "bootstrap_enabled": "sometimes",
            },
        )
        request(
            "POST",
            "/projects",
            {
                "title": "extra field",
                "origin": "start",
                "goal": "finish",
                "unknown": "ignored by pydantic",
            },
        )
        request("GET", "/projects")
        request("GET", "/projects/proj_001")
        request("GET", "/projects/proj_999")
        request("PUT", "/projects/proj_001/title", {"title": "renamed"})
        request("PUT", "/projects/proj_001/title", {"title": "   "})
        request("PUT", "/projects/proj_001/status", {"status": "paused"})

        # Intent -> heartbeat -> conclude -> complete -> reopen.
        request(
            "POST",
            "/projects/proj_001/intents",
            {
                "from": ["origin"],
                "description": "investigate",
                "creator": "reasoner",
                "worker": None,
            },
        )
        request(
            "POST",
            "/projects/proj_001/intents",
            {
                "from": ["goal"],
                "description": "invalid",
                "creator": "reasoner",
                "worker": None,
            },
        )
        request(
            "POST",
            "/projects/proj_001/intents",
            {
                "from": ["origin"],
                "description": "invalid worker",
                "creator": "reasoner",
                "worker": "explorer",
            },
        )
        request(
            "POST",
            "/projects/proj_001/intents/i001/heartbeat",
            {"worker": "explorer"},
        )
        request(
            "POST",
            "/projects/proj_001/intents/i001/conclude",
            {"worker": "explorer", "description": "new fact"},
        )
        request(
            "POST",
            "/projects/proj_001/intents/i001/heartbeat",
            {"worker": "explorer"},
        )
        request(
            "POST",
            "/projects/proj_001/complete",
            {"from": ["f001"], "description": "solved", "worker": "reasoner"},
        )
        request(
            "POST",
            "/projects/proj_001/complete",
            {"from": ["f001"], "description": "again", "worker": "reasoner"},
        )
        request(
            "POST",
            "/projects/proj_001/reopen",
            {"description": "human correction", "creator": "human"},
        )
        request("GET", "/projects/proj_001")
        request("GET", "/projects/proj_001/export?format=yaml")
        request("GET", "/projects/proj_001/export")
        request("GET", "/projects/proj_001/export?format=timeline")
        request("GET", "/projects/proj_001/export?format=invalid")
        request("POST", "/projects/proj_002/reopen", {"description": "no", "creator": "h"})
        request("GET", "/projects/proj_001/export?format=timeline")

        # Status transitions, hints, and reason leases.
        request("PUT", "/projects/proj_001/status", {"status": "stopped"})
        request(
            "POST",
            "/projects/proj_001/hints",
            {"content": "manual note", "creator": "human"},
        )
        request(
            "POST",
            "/projects/proj_001/intents",
            {
                "from": ["origin"],
                "description": "blocked",
                "creator": "reasoner",
                "worker": None,
            },
        )
        request("PUT", "/projects/proj_001/status", {"status": "active"})
        request(
            "POST",
            "/projects/proj_001/reason/claim",
            {"worker": "worker-a", "trigger": "bootstrap"},
        )
        request(
            "POST",
            "/projects/proj_001/reason/claim",
            {"worker": "worker-b", "trigger": "facts:2->3"},
        )
        request(
            "POST",
            "/projects/proj_001/reason/heartbeat",
            {"worker": "worker-a"},
        )
        request(
            "POST",
            "/projects/proj_001/reason/release",
            {"worker": "worker-b"},
        )
        request(
            "POST",
            "/projects/proj_001/reason/release",
            {"worker": "worker-a"},
        )
        request(
            "POST",
            "/projects/proj_001/reason/heartbeat",
            {"worker": "worker-a"},
        )

        # Completion and deletion of project 2.
        request(
            "POST",
            "/projects/proj_002/complete",
            {"from": ["origin"], "description": "done", "worker": "reasoner"},
        )
        request(
            "POST",
            "/projects/proj_002/complete",
            {"from": ["origin"], "description": "again", "worker": "reasoner"},
        )
        request("DELETE", "/projects/proj_002")
        request("GET", "/projects/proj_002")
        request(
            "POST",
            "/projects/proj_999/intents",
            {"from": ["origin"], "description": "x", "creator": "r", "worker": None},
        )

        # Lease expiry: a live-looking claim whose heartbeat is from 2000.
        request(
            "POST",
            "/projects",
            {"title": "lease", "origin": "o", "goal": "g"},
        )
        request(
            "POST",
            "/projects/proj_004/intents",
            {
                "from": ["origin"],
                "description": "work",
                "creator": "worker-a",
                "worker": "worker-a",
            },
        )
        request(
            "POST",
            "/projects/proj_004/reason/claim",
            {"worker": "worker-a", "trigger": "bootstrap"},
        )
        sql(
            "UPDATE intents SET last_heartbeat_at = '2000-01-01T00:00:00Z' WHERE project_id = ?",
            ("proj_004",),
        )
        sql(
            "UPDATE projects SET reason_last_heartbeat_at = '2000-01-01T00:00:00Z' WHERE id = ?",
            ("proj_004",),
        )
        request(
            "POST",
            "/projects/proj_004/intents/i001/heartbeat",
            {"worker": "worker-b"},
        )
        request(
            "POST",
            "/projects/proj_004/reason/claim",
            {"worker": "worker-b", "trigger": "facts:2->3"},
        )
        request(
            "POST",
            "/projects/proj_004/intents/i001/release",
            {"worker": "worker-b"},
        )
        request(
            "POST",
            "/projects/proj_004/intents/i001/conclude",
            {"worker": "worker-b", "description": "claimed after expiry"},
        )
        request(
            "POST",
            "/projects/proj_004/complete",
            {"from": ["f001"], "description": "done", "worker": "worker-b"},
        )
        request("PUT", "/projects/proj_004/status", {"status": "active"})
        request("GET", "/projects")

        # Routing errors.
        request("GET", "/does-not-exist")
        request("PATCH", "/projects/proj_001")
        request(
            "POST",
            "/projects",
            {
                "title": "bad hint",
                "origin": "o",
                "goal": "g",
                "hints": [{"content": "   ", "creator": "human"}],
            },
        )

    api_payload = {
        "timezone": "UTC",
        "clock_start": "2026-01-02T03:04:05Z",
        "clock_step_seconds": 60,
        "steps": steps,
    }
    api_out = out_root / "apps" / "cairn" / "src" / "http" / "testdata" / "api.golden.json"
    api_out.parent.mkdir(parents=True, exist_ok=True)
    api_out.write_text(
        json.dumps(api_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {api_out} ({len(steps)} steps)")

    # --- Export fixture ------------------------------------------------------------------
    fixture_rows = export_fixture_rows()
    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO projects (id, title, status, bootstrap_enabled, created_at) VALUES (?, ?, 'active', 1, ?)",
            ("proj_005", fixture_rows["project_title"], "2026-01-02T03:04:05Z"),
        )
        for fact in fixture_rows["facts"]:
            conn.execute(
                "INSERT INTO facts (id, project_id, description) VALUES (?, 'proj_005', ?)",
                (fact["id"], fact["description"]),
            )
        for hint in fixture_rows["hints"]:
            conn.execute(
                "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, 'proj_005', ?, ?, ?)",
                (hint["id"], hint["content"], hint["creator"], hint["created_at"]),
            )
        for intent in fixture_rows["intents"]:
            conn.execute(
                "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, 'proj_005', ?, ?, ?, ?, ?, ?, ?)",
                (
                    intent["id"],
                    intent["to"],
                    intent["description"],
                    intent["creator"],
                    intent["worker"],
                    intent["last_heartbeat_at"],
                    intent["created_at"],
                    intent["concluded_at"],
                ),
            )
            for source in intent["from"]:
                conn.execute(
                    "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, 'proj_005', ?)",
                    (intent["id"], source),
                )

        expected_yaml = _export_yaml(conn, "proj_005")
        expected_timeline = _export_timeline(conn, "proj_005")

    export_payload = {
        "timezone": "UTC",
        "project": {
            "id": "proj_005",
            "title": fixture_rows["project_title"],
            "created_at": "2026-01-02T03:04:05Z",
        },
        "facts": fixture_rows["facts"],
        "hints": fixture_rows["hints"],
        "intents": fixture_rows["intents"],
        "expected": {"yaml": expected_yaml, "timeline": expected_timeline},
    }
    export_out = out_root / "packages" / "graph" / "testdata" / "export.golden.json"
    export_out.parent.mkdir(parents=True, exist_ok=True)
    export_out.write_text(
        json.dumps(export_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {export_out}")

    # --- Scalar emitter corpus ------------------------------------------------------------
    import yaml

    scalar_cases = [
        "plain",
        "a: b",
        "a # b",
        "- item",
        "-foo",
        "it's fine",
        'say "hi"',
        "123",
        "1.5",
        "0x1f",
        "0123",
        "1:20",
        "true",
        "Yes",
        "~",
        "null",
        "",
        " a ",
        "  leading and trailing  ",
        "word " * 25,
        ("a: b " * 20).strip(),
        "x" * 120,
        "line1\nline2",
        "line1\n\nline2",
        "line1\n",
        "\nfoo",
        "\nfoo\n",
        "中文测试",
        "中文事实 with emoji 🚩",
        "中文 " * 30,
        "a\\b",
        "a\\nb",
        "http://example.com/a?b=c",
        "a,b",
        "a#b",
        "@foo",
        "*foo",
        "&foo",
        "{a}",
        "[a]",
        "|",
        ">",
        "%foo",
        "`foo",
        "? foo",
        "!foo",
        "a-b",
        "1.2.3",
        "a  b",
        "it's a 'test'",
        "a\tb",
        "a\x01b",
        "2026-10-25",
        "2026-10-25 12:34:56",
        "...",
        "---",
        "'foo",
        '"foo',
        "a:",
        "a: ",
        "#foo",
    ]
    scalar_payload = [
        {
            "value": value,
            "yaml": yaml.dump(
                {"v": value},
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            ),
        }
        for value in scalar_cases
    ]
    scalars_out = out_root / "packages" / "graph" / "testdata" / "scalars.golden.json"
    scalars_out.write_text(
        json.dumps(scalar_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {scalars_out} ({len(scalar_payload)} cases)")

    # --- Prompt rendering corpus ---------------------------------------------------------
    from cairn.dispatcher import prompting as prompting_module
    from cairn.dispatcher import config as config_module

    # This is the exact text built by dispatcher/tasks/common.write_graph_snapshot_reference.
    # The phase and UUID are fixed so the golden is deterministic.
    def graph_reference(phase: str) -> str:
        path = f"/tmp/cairn-prompts/{phase}-0123456789ab/graph.yaml"
        return (
            "The graph YAML snapshot is stored in this file inside the current container:\n\n"
            f"{path}\n\n"
            "Before using the graph, read the entire file and treat its contents as the YAML snapshot "
            "for this Graph section."
        )

    fact_ids = ["f001", "f002", "f003"]
    open_intents = [
        {
            "id": "i001",
            "from": ["f001"],
            "description": "Probe the admin endpoint — then stop",
            "worker": "worker-a",
        },
        {
            "id": "i002",
            "from": ["f002", "f003"],
            "description": '中文意图 with "quotes" and\na newline',
            "worker": None,
        },
    ]
    hint_rows = [
        {
            "id": "h001",
            "content": "initial clue",
            "creator": "human",
            "created_at": "2026-01-02T03:04:05Z",
        },
        {
            "id": "h002",
            "content": "literal {origin} token and 中文 🚩\nsecond line\ttab",
            "creator": "analyst",
            "created_at": "2026-01-02T03:05:00Z",
        },
    ]

    intent_description = (
        "Investigate the staging host: collect headers # then ports\nsecond line"
    )
    explore_replacements = {
        "graph_yaml": graph_reference("explore_execute"),
        "intent_id": "i001",
        "intent_description": intent_description,
    }
    explore_conclude_replacements = {
        "graph_yaml": graph_reference("explore_conclude"),
        "intent_id": "i001",
        "intent_description": intent_description,
    }
    reason_replacements = {
        "graph_yaml": graph_reference("reason_execute"),
        "fact_ids": prompting_module.format_fact_ids(fact_ids),
        "open_intents": prompting_module.format_open_intents(open_intents),
        "max_intents": "3",
    }
    bootstrap_replacements = {
        "origin": 'start at https://example.test/a?b=c\n"quoted" origin',
        "goal": "find the flag 🚩 and prove access",
        "hints": prompting_module.format_hints(hint_rows),
    }
    replacements_by_name = {
        "reason.md": reason_replacements,
        "explore.md": explore_replacements,
        "explore_conclude.md": explore_conclude_replacements,
        "bootstrap.md": bootstrap_replacements,
        "bootstrap_conclude.md": bootstrap_replacements,
    }

    prompt_cases = []
    for group in ("default", "mock"):
        for name in (
            "reason.md",
            "explore.md",
            "explore_conclude.md",
            "bootstrap.md",
            "bootstrap_conclude.md",
        ):
            template = prompting_module.load_prompt(group, name)
            replacements = replacements_by_name[name]
            prompt_cases.append(
                {
                    "group": group,
                    "name": name,
                    "replacements": replacements,
                    "template": template,
                    "rendered": prompting_module.render_prompt(template, replacements),
                }
            )

    prompt_payload = {
        "cases": prompt_cases,
        "formatters": {
            "fact_ids": {
                "input": fact_ids,
                "output": prompting_module.format_fact_ids(fact_ids),
            },
            "open_intents": {
                "input": open_intents,
                "output": prompting_module.format_open_intents(open_intents),
            },
            "hints": {
                "input": hint_rows,
                "output": prompting_module.format_hints(hint_rows),
            },
        },
        "required_tokens": {
            "default": {
                name: list(tokens)
                for name, tokens in config_module.DEFAULT_PROMPT_REQUIRED_TOKENS.items()
            },
            "mock": {
                name: list(tokens)
                for name, tokens in config_module.PROMPT_REQUIRED_TOKENS_BY_GROUP[
                    "mock"
                ].items()
            },
        },
    }
    prompts_out = out_root / "apps" / "cairn" / "src" / "prompts" / "testdata" / "prompts.golden.json"
    prompts_out.parent.mkdir(parents=True, exist_ok=True)
    prompts_out.write_text(
        json.dumps(prompt_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {prompts_out} ({len(prompt_cases)} cases)")
    return 0


def export_fixture_rows() -> dict[str, Any]:
    long_origin = (
        "The engagement starts at the public web front end. "
        "Enumerate virtual hosts, collect TLS certificate names and record every "
        "reachable HTTP service before attempting any exploitation."
    )
    return {
        "project_title": "multi\nline title",
        "facts": [
            {"id": "origin", "description": long_origin},
            {"id": "goal", "description": "line one\nline two"},
            {"id": "f001", "description": "2026-01-02 03:04:05"},
            {"id": "f002", "description": "say \"hi\" and it's fine"},
            {"id": "f003", "description": "中文事实 with emoji 🚩"},
            {"id": "f004", "description": "tab\there"},
        ],
        "hints": [
            {
                "id": "h001",
                "content": "  leading and trailing  ",
                "creator": "true",
                "created_at": "2026-01-02T03:04:05Z",
            },
            {
                "id": "h002",
                "content": "a: b # c",
                "creator": "human",
                "created_at": "2026-01-02T03:04:05+02:00",
            },
            {
                "id": "h003",
                "content": "not-a-date hint",
                "creator": "human",
                "created_at": "not-a-date",
            },
        ],
        "intents": [
            {
                "id": "i001",
                "from": ["f001", "f002"],
                "to": "f003",
                "description": "Investigate the staging host: collect headers # then ports",
                "creator": "reasoner",
                "worker": "explorer",
                "last_heartbeat_at": "2026-01-02T03:10:00Z",
                "created_at": "2026-01-02T03:05:00Z",
                "concluded_at": "2026-01-02T03:20:00Z",
            },
            {
                "id": "i002",
                "from": [],
                "to": None,
                "description": "Open follow-up without sources",
                "creator": "reasoner",
                "worker": "explorer",
                "last_heartbeat_at": "2026-01-02T03:12:00Z",
                "created_at": "2026-01-02T03:06:00Z",
                "concluded_at": None,
            },
            {
                "id": "i003",
                "from": ["f001"],
                "to": "goal",
                "description": "solved",
                "creator": "reasoner",
                "worker": "reasoner",
                "last_heartbeat_at": "2026-01-02T03:30:00Z",
                "created_at": "2026-01-02T03:25:00Z",
                "concluded_at": "2026-01-02T03:30:00Z",
            },
        ],
    }


if __name__ == "__main__":
    raise SystemExit(main())
