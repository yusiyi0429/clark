"""本机清单（上手流程的后台扫描）：python -m unittest discover -s tools/collector -p "test_*.py" """
from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tkos_collector  # noqa: E402


class MemoryFiles(unittest.TestCase):
    def test_lists_paths_and_sizes_without_content(self):
        with tempfile.TemporaryDirectory() as root:
            claude, codex = Path(root, ".claude"), Path(root, ".codex")
            (claude / "projects" / "repo-a" / "memory").mkdir(parents=True)
            (claude / "projects" / "repo-a" / "memory" / "MEMORY.md").write_text("先给结论", encoding="utf-8")
            (claude / "projects" / "repo-a" / "session.jsonl").write_text("{}", encoding="utf-8")  # 会话不是记忆
            (claude / "CLAUDE.md").write_text("说中文", encoding="utf-8")
            (codex / "memories").mkdir(parents=True)
            (codex / "AGENTS.md").write_text("x" * 10, encoding="utf-8")
            files = tkos_collector.memory_files(claude, codex)
        self.assertEqual(sorted((f["source"], Path(f["path"]).name, f["bytes"]) for f in files),
                         [("claude", "CLAUDE.md", len("说中文".encode("utf-8"))), ("claude", "MEMORY.md", len("先给结论".encode("utf-8"))), ("codex", "AGENTS.md", 10)])
        self.assertTrue(all(set(f) == {"source", "path", "bytes", "modifiedAt"} for f in files))


class FirstCheck(unittest.TestCase):
    def run_check(self, state: dict, post):
        with tempfile.TemporaryDirectory() as root:
            config, state_file = Path(root, "collector.json"), Path(root, "state.json")
            config.write_text(json.dumps({"server": "https://tianshu.example"}), encoding="utf-8")
            state_file.write_text(json.dumps(state), encoding="utf-8")
            args = argparse.Namespace(dry_run=False, config=config, state=state_file, codex_home=Path(root, "codex"), claude_home=Path(root, "claude"),
                                      now=datetime(2026, 10, 18, 2, 0, tzinfo=timezone.utc))
            with mock.patch.object(tkos_collector, "read_token", return_value="t"), \
                 mock.patch.object(tkos_collector, "scheduled_tasks", return_value=[{"name": "周报", "schedule": "Weekly", "command": None}]), \
                 mock.patch.object(tkos_collector.Api, "post", autospec=True, side_effect=post), \
                 mock.patch("sys.stderr", io.StringIO()):
                code = tkos_collector.run("check", args)
            return code, json.loads(state_file.read_text(encoding="utf-8"))

    def test_first_check_sends_inventory_with_heartbeat(self):
        calls = []
        code, state = self.run_check({}, lambda _api, path, body: calls.append((path, body)) or {})
        self.assertEqual(code, 0)
        self.assertEqual([path for path, _ in calls], ["/api/collector/heartbeat"])
        self.assertEqual(calls[0][1]["inventory"]["scheduledTasks"][0]["name"], "周报")
        self.assertIn("memoryFiles", calls[0][1]["inventory"])
        self.assertIn("inventory_at", state)

    def test_refused_report_stays_local_and_heartbeat_still_goes(self):
        pending = {"device": {}, "kind": "digest", "windowStart": "a", "windowEnd": "b", "items": [{"clientEventId": "x"}]}
        calls = []

        def post(_api, path, body):
            calls.append(path)
            if path == "/api/collector/reports":
                raise urllib.error.HTTPError(path, 403, "Forbidden", {}, None)
            return {}
        code, state = self.run_check({"pending": [pending], "inventory_at": "2026-10-18T01:00:00Z"}, post)
        self.assertEqual(code, 0)
        self.assertEqual(calls, ["/api/collector/reports", "/api/collector/heartbeat"])
        self.assertEqual(state["pending"], [pending])


if __name__ == "__main__":
    unittest.main()
