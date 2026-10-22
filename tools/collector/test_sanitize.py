"""上传前脱敏与裁剪的测试：python -m unittest discover -s tools/collector -p "test_*.py"

假密钥都在运行时拼出来，源码里不出现完整的密钥形状（免得被仓库的密钥扫描当成真泄露）。
"""
from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_sessions as cs  # noqa: E402
import sanitize  # noqa: E402
import tkos_collector  # noqa: E402

R = sanitize.REDACTED


def fake(prefix: str, body: str = "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6", times: int = 1) -> str:
    return prefix + body * times


class RedactSecrets(unittest.TestCase):
    def assertGone(self, secret: str, text: str) -> str:
        cleaned = sanitize.sanitize(text)
        self.assertNotIn(secret, cleaned, cleaned)
        self.assertIn(R, cleaned)
        return cleaned

    def test_common_key_formats(self):
        cases = {
            "OpenAI": fake("sk-proj-"),
            "Anthropic": fake("sk-ant-api03-"),
            "GitHub classic": fake("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
            "GitHub fine-grained": fake("github_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789"),
            "GitLab": fake("glpat-", "abcdefghijklmnopqrst"),
            "Slack": fake("xoxb-", "1234567890-abcdefghij"),
            "AWS": "AKIA" + "IOSFODNN7EXAMPLE",
            "Google": "AIza" + "SyA1234567890abcdefghijklmnopqrstuv",
            "LangSmith": fake("lsv2_pt_", "0123456789abcdef0123456789abcdef"),
            "天枢个人令牌": fake("tsm_", "0123456789abcdef0123456789abcdef"),
            "飞书 user token": fake("u-", "7mT8sKq2Lx9Pz3Vb5Nc1Df6Gh4Jk0WeR"),
            "JWT": "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        }
        for name, secret in cases.items():
            with self.subTest(name):
                self.assertGone(secret, f"用这个 {secret} 调一下接口")

    def test_key_value_and_headers(self):
        self.assertGone("hunter2hunter2", 'password: "hunter2hunter2"')
        self.assertGone("abc123def456", '{"api_key": "abc123def456"}')
        self.assertGone("s3cr3tValue", "client_secret=s3cr3tValue")
        self.assertGone("abcdefghijklmnop", "curl -H 'Authorization: Bearer abcdefghijklmnop'")
        self.assertGone("mytokenvalue", "lark-cli --token mytokenvalue")
        cleaned = self.assertGone("p4ssw0rd", "DATABASE_URL=postgres://warmap:p4ssw0rd@db:5432/warmap")
        self.assertNotIn("p4ssw0rd", cleaned)

    def test_env_values(self):
        self.assertGone("prod-value-123", "export TKOS_WORLD_API_URL=prod-value-123")
        self.assertGone("some-heavy-model", "HEAVY_MODEL=some-heavy-model pnpm dev")
        self.assertGone("C:/secret/path.token", '$env:TKOS_WORLD_AGENT_TOKEN_FILE = "C:/secret/path.token"')
        self.assertGone("deadbeef", "SESSION_SECRET='deadbeef'\nPORT=4000")

    def test_private_key_block(self):
        block = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"
        self.assertGone("b3BlbnNzaC1rZXktdjEAAAAA", f"钥匙是\n{block}\n别外传")

    def test_plain_conversation_stays(self):
        text = "把周复盘页的出处标记改小一点，10/16 前给铭泽看。见 https://github.com/TokenkingOS/Tianshu-MVP/pull/19"
        self.assertEqual(sanitize.sanitize(text), text)
        self.assertEqual(sanitize.sanitize("totalTokens: 12，status=ok"), "totalTokens: 12，status=ok")


class Trim(unittest.TestCase):
    def test_long_code_block_dropped_short_kept(self):
        long_block = "```ts\n" + "\n".join(f"const a{i} = {i};" for i in range(10)) + "\n```"
        self.assertEqual(sanitize.sanitize(f"改成这样：\n{long_block}\n可以吗"), "改成这样：\n[代码已略去]\n可以吗")
        short = "```sh\npnpm test\n```"
        self.assertIn("pnpm test", sanitize.sanitize(short))

    def test_tool_output_dropped(self):
        text = "跑一下\n<local-command-stdout>FAIL apps/api 3 tests\nError: boom</local-command-stdout>\n看看为什么"
        cleaned = sanitize.sanitize(text)
        self.assertNotIn("boom", cleaned)
        self.assertIn("[输出已略去]", cleaned)
        self.assertNotIn("提醒正文", sanitize.sanitize("<system-reminder>提醒正文</system-reminder>好"))

    def test_indented_log_dropped(self):
        log = "\n".join(f"    at frame{i} (file.ts:{i})" for i in range(10))
        cleaned = sanitize.sanitize(f"报错了：\n{log}\n怎么修")
        self.assertEqual(cleaned, "报错了：\n[输出已略去]\n怎么修")

    def test_secret_inside_short_code_still_redacted(self):
        secret = fake("sk-", "abcdefghijklmnopqrstuvwx")
        self.assertNotIn(secret, sanitize.sanitize(f"```\nOPENAI_KEY={secret}\n```"))


class Upload(unittest.TestCase):
    def test_item_keeps_text_time_and_repo_only(self):
        start = datetime(2026, 10, 16, 0, 0, tzinfo=timezone.utc)
        secret = fake("ghp_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")
        session = cs.Session("Claude Code", "s1", cwd="C:\\Users\\someone\\Desktop\\clark\\Tianshu-MVP")
        session.requests.append((datetime(2026, 10, 16, 1, 5, tzinfo=timezone.utc), f"用 {secret} 推一下\n```\n" + "x\n" * 20 + "```"))
        session.answers.append((datetime(2026, 10, 16, 1, 9, tzinfo=timezone.utc), "推好了 https://github.com/TokenkingOS/Tianshu-MVP/pull/20"))
        session.answers.append((datetime(2026, 10, 16, 1, 10, tzinfo=timezone.utc), "预发在 https://tk-preview.tokenkingos.com，入口 `https://tk.tokenkingos.com/me`。"))
        item = tkos_collector.to_item(session, "device-1", start, datetime(2026, 10, 16, 3, 0, tzinfo=timezone.utc))
        self.assertTrue(item["summary"].startswith("仓库：Tianshu-MVP\n"))
        self.assertNotIn("someone", item["summary"])
        self.assertNotIn(secret, item["summary"])
        self.assertIn("[代码已略去]", item["summary"])
        self.assertEqual(item["taskHint"], "Tianshu-MVP")
        self.assertEqual(item["links"], [{"url": "https://github.com/TokenkingOS/Tianshu-MVP/pull/20"},
                                         {"url": "https://tk-preview.tokenkingos.com"}, {"url": "https://tk.tokenkingos.com/me"}])


if __name__ == "__main__":
    unittest.main()
