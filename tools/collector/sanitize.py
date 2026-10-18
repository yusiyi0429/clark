"""上传前的脱敏与裁剪（D-02）：本机只做这一步，整理交给天枢服务端。

只留对话文字、时间、仓库名：
- 去掉密钥、令牌、口令、连接串里的密码、私钥块，以及环境变量的值（`NAME=value`、`export NAME=value`、`$env:NAME = "value"`）；
- 去掉长代码块（多于 MAX_CODE_LINES 行或 MAX_CODE_CHARS 字的 ``` 块）、工具输出（命令回显、系统提醒这类标签段，
  连续缩进的大段日志）；
- 工作目录只留最后一级（仓库名），不上传完整路径。

collect_sessions.py 里原有的 redact 先跑一遍，这里在它之后补齐。只用标准库。
"""
from __future__ import annotations

from pathlib import Path
import re

import collect_sessions as cs

REDACTED = "[已隐去]"
MAX_CODE_LINES = 6
MAX_CODE_CHARS = 400
MAX_INDENTED_LINES = 6

_SECRETS: list[tuple[re.Pattern[str], str]] = [
    # 私钥块整段去掉
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)", re.S), REDACTED),
    # 带口令的连接串：scheme://user:password@host
    (re.compile(r"\b([a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@]+:)[^\s@/]+@"), rf"\1{REDACTED}@"),
    # 常见前缀的密钥与令牌
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}"), REDACTED),
    (re.compile(r"\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}"), REDACTED),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}"), REDACTED),
    (re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}"), REDACTED),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), REDACTED),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), REDACTED),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), REDACTED),
    (re.compile(r"\blsv2_(?:pt|sk)_[A-Za-z0-9_]{16,}"), REDACTED),
    (re.compile(r"\b(?:tsm|tsk)_[A-Za-z0-9_]{20,}"), REDACTED),
    (re.compile(r"\b[tu]-[A-Za-z0-9_.-]{30,}"), REDACTED),  # 飞书 tenant / user access token
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), REDACTED),  # JWT
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), rf"\1 {REDACTED}"),
    # key: value / key=value 写法（JSON、YAML、命令行参数）
    (re.compile(r"(?i)([\"']?\b[\w.-]*(?:password|passwd|passcode|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[\"']?\s*[:=]\s*[\"']?)"
                r"[^\s\"',;}，；。、）)]{6,}"), rf"\1{REDACTED}"),
    (re.compile(r"(?i)(--(?:password|token|secret|api-key|key)[= ])\S+"), rf"\1{REDACTED}"),
]
# 环境变量的值：行首或命令里的 NAME=value（NAME 全大写），PowerShell 的 $env:NAME = value，.env 文件行
_ENV = [
    re.compile(r"(?m)((?:^|[\s;&|(])(?:export\s+|set\s+)?[A-Z][A-Z0-9_]{2,}=)(\"[^\"\n]*\"|'[^'\n]*'|[^\s;&|)]+)"),
    re.compile(r"(?i)(\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(\"[^\"\n]*\"|'[^'\n]*'|\S+)"),
]
_FENCE = re.compile(r"```[^\n]*\n(.*?)(?:```|\Z)", re.S)
_TOOL_TAGS = re.compile(
    r"<(local-command-stdout|local-command-stderr|command-output|bash-stdout|bash-stderr|tool_result|function_results|system-reminder|stdout|stderr)\b[^>]*>"
    r".*?(?:</\1>|\Z)", re.S | re.I)


def redact_secrets(text: str) -> str:
    """密钥、令牌、口令、环境变量的值换成 [已隐去]。"""
    text = cs.redact(text)
    for pattern, replacement in _SECRETS:
        text = pattern.sub(replacement, text)
    for pattern in _ENV:
        text = pattern.sub(lambda m: m.group(1) + REDACTED, text)
    return text


def _code(match: re.Match[str]) -> str:
    body = match.group(1)
    if body.count("\n") + 1 > MAX_CODE_LINES or len(body) > MAX_CODE_CHARS:
        return "[代码已略去]"
    return match.group(0)


def _drop_indented(text: str) -> str:
    """连续多行缩进（日志、堆栈、粘贴的代码）只留一行占位。"""
    out: list[str] = []
    block: list[str] = []

    def flush() -> None:
        if len(block) > MAX_INDENTED_LINES:
            out.append("[输出已略去]")
        else:
            out.extend(block)
        block.clear()

    for line in text.split("\n"):
        if line.startswith(("    ", "\t")) and line.strip():
            block.append(line)
            continue
        flush()
        out.append(line)
    flush()
    return "\n".join(out)


def trim(text: str) -> str:
    """去掉工具输出、长代码块和大段缩进输出，只留对话文字。"""
    text = _TOOL_TAGS.sub("[输出已略去]", text)
    text = _FENCE.sub(_code, text)
    return _drop_indented(text)


def sanitize(text: str) -> str:
    """先裁剪再脱敏：裁剪后留下的短代码、命令里也不带密钥和环境变量的值。"""
    return redact_secrets(trim(text))


def repo_name(cwd: str) -> str:
    """工作目录只留最后一级。"""
    return Path(cwd.replace("\\", "/")).name if cwd else ""
