"""本机采集器：读本机 Codex、Claude Code 会话，按水位线增量整理，上报到天枢。

    python tkos_collector.py check      # 定时任务每 30 分钟跑：轻量检查，不调模型
    python tkos_collector.py sync       # 一键同步：不等 3 小时，现在就整理一次
    python tkos_collector.py check --dry-run   # 只打印要发的内容，不联网、不改状态

会话读取复用 collect_sessions.py（与 tkos-world-daily skill 里的同一份，未改动）。
上传前在本机脱敏和裁剪（sanitize.py）：去掉密钥、令牌、环境变量的值、长代码块和工具输出，只留对话文字、时间、仓库名；整理在天枢服务端做。
天枢那边要本人在上手流程里同意采集才收工作段，没同意时上报返回 403，待发的留在本机，同意后下次检查原样发出。
水位线与设备 id 存在 ~/.tkos-world/daily-state.json；服务地址在 ~/.tkos-world/collector.json；
令牌在 ~/.tkos-world/collector.token（或环境变量 TKOS_COLLECTOR_TOKEN），不进仓库、不打印。
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, time, timedelta, timezone
import json
from pathlib import Path
import platform
import re
import socket
import subprocess
import sys
from typing import Any, Optional
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_sessions as cs  # noqa: E402
import sanitize  # noqa: E402

VERSION = "0.2.0"
HOME = Path.home() / ".tkos-world"
DIGEST_EVERY = timedelta(hours=3)
INVENTORY_EVERY = timedelta(hours=24)  # 本机清单每天完整盘点一次，随心跳带上；装好后第一次检查就盘点
FEISHU_LOOKBACK = timedelta(days=30)   # 盘点「读过的飞书文档」往回看 30 天的会话
MAX_PENDING = 200                      # 天枢还没同意采集时，待发的上报最多留这么多份
SETTLE = timedelta(minutes=2)       # 正在写的会话行可能晚到，窗口只到「现在减两分钟」
CATCHUP_DAYS = 7                    # 补跑最多往回 7 天
MAX_ITEMS = 100                     # 一次上报最多这么多段，多了分几次发
_FEISHU = re.compile(r"https://[A-Za-z0-9.-]*(?:feishu\.cn|larksuite\.com)/(?:docx|docs|wiki|sheets|base)/[A-Za-z0-9_-]+")


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def read_token(config: dict[str, Any]) -> str:
    import os
    token = os.environ.get("TKOS_COLLECTOR_TOKEN") or ""
    if not token:
        path = Path(config.get("token_file") or HOME / "collector.token").expanduser()
        token = path.read_text(encoding="utf-8").strip() if path.exists() else ""
    if not token:
        raise SystemExit("缺采集器令牌：在天枢生成「本机采集器」令牌，存进 ~/.tkos-world/collector.token")
    return token


# ---------- 读会话 ----------

def sessions_in(start: datetime, end: datetime, codex_home: Path, claude_home: Path) -> tuple[list[cs.Session], dict[str, str]]:
    """窗口 [start, end) 里的会话（沿用 collect_sessions 的读取与过滤），以及各来源状态。"""
    status: dict[str, str] = {}
    found: list[Optional[cs.Session]] = []
    tz = start.tzinfo
    day, last = start.astimezone(tz).date(), end.astimezone(tz).date()
    try:
        if not codex_home.is_dir():
            status["codex"] = "not_found"
        else:
            paths: dict[Path, None] = {}
            while day <= last:
                paths.update(dict.fromkeys(cs.codex_files(codex_home, day, start)))
                day += timedelta(days=1)
            found += [cs.codex_session(path, start, end) for path in paths]
            status["codex"] = "ok"
    except OSError:
        status["codex"] = "error"
    try:
        if not (claude_home / "projects").is_dir():
            status["claude"] = "not_found"
        else:
            found += [cs.claude_session(path, start, end) for path in cs.claude_files(claude_home, start)]
            status["claude"] = "ok"
    except OSError:
        status["claude"] = "error"
    return [s for s in found if s is not None and (s.requests or s.answers)], status


SOURCE = {"Codex": "codex", "Claude Code": "claude"}


def to_item(session: cs.Session, device_id: str, start: datetime, end: datetime) -> dict[str, Any]:
    times = session.times()
    hint = sanitize.repo_name(session.cwd or "")
    lines = [f"仓库：{hint or '未知'}"]
    texts: list[str] = []
    for title, entries in (("请求", session.requests), ("答复", session.answers)):
        if entries:
            lines.append(f"{title}：")
            for moment, text in entries[-12:]:
                clean = sanitize.sanitize(text)
                texts.append(clean)
                lines.append(f"- {moment.astimezone(start.tzinfo):%H:%M} {cs.clip(clean, 300)}")
    links = list(dict.fromkeys(url.rstrip(".,;:，。；") for text in texts for url in cs._URL.findall(text)))
    return {
        "clientEventId": str(uuid.uuid5(uuid.NAMESPACE_URL, f"tkos-collector:{device_id}:{session.tool}:{session.session_id}:{iso(start)}:{iso(end)}")),
        "source": SOURCE[session.tool],
        "startedAt": iso(min(times)), "endedAt": iso(max(times)),
        "summary": "\n".join(lines)[:4000],
        "links": [{"url": url} for url in links if len(url) <= 500][:20],
        "taskHint": hint[:200] or None,
    }


def feishu_docs(sessions: list[cs.Session]) -> list[dict[str, Any]]:
    seen: dict[str, datetime] = {}
    for session in sessions:
        for moment, text in session.requests + session.answers:
            for url in _FEISHU.findall(text):
                seen[url] = max(seen.get(url, moment), moment)
    return [{"url": url, "title": None, "readAt": iso(moment)} for url, moment in seen.items()][:200]


# ---------- 本机定时任务 ----------

def scheduled_tasks() -> list[dict[str, Any]]:
    """用户自己建的定时任务：Windows 任务计划程序根目录、macOS 的 ~/Library/LaunchAgents、Linux 的 crontab。读不了就空。"""
    system = platform.system()
    try:
        if system == "Windows":
            script = ("Get-ScheduledTask -TaskPath '\\' | ForEach-Object { [pscustomobject]@{ name=$_.TaskName; "
                      "schedule=(($_.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace '^MSFT_Task','' -replace 'Trigger$','' }) -join ', '); "
                      "command=(($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\".Trim() }) -join ' ; ') } } | ConvertTo-Json -Compress")
            out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                                 capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60).stdout.strip()
            rows = json.loads(out) if out else []
            rows = rows if isinstance(rows, list) else [rows]
        elif system == "Darwin":
            import plistlib
            rows = []
            for path in sorted((Path.home() / "Library" / "LaunchAgents").glob("*.plist")):
                with path.open("rb") as stream:
                    plist = plistlib.load(stream)
                interval = plist.get("StartInterval")
                rows.append({"name": str(plist.get("Label") or path.stem),
                             "schedule": f"每 {interval} 秒" if interval else ("StartCalendarInterval" if "StartCalendarInterval" in plist else ""),
                             "command": " ".join(map(str, plist.get("ProgramArguments") or [plist.get("Program") or ""]))})
        else:
            out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
            rows = [{"name": line.split(None, 5)[-1][:200], "schedule": " ".join(line.split()[:5]), "command": line.split(None, 5)[-1]}
                    for line in out.splitlines() if line.strip() and not line.lstrip().startswith("#") and len(line.split()) > 5]
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    return [{"name": str(row["name"])[:200], "schedule": (str(row.get("schedule") or "")[:200] or None),
             "command": (sanitize.redact_secrets(str(row.get("command") or ""))[:500] or None)} for row in rows if row.get("name")][:200]


# ---------- 记忆文件盘点 ----------

def _home_path(path: Path) -> str:
    try:
        return "~/" + path.resolve().relative_to(Path.home().resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def memory_files(claude_home: Path, codex_home: Path) -> list[dict[str, Any]]:
    """Claude Code、Codex 的记忆文件：只盘点路径、大小、修改时间，不读正文（正文等记忆导入时本人同意后再传）。"""
    patterns = (("claude", claude_home, ("CLAUDE.md", "projects/*/memory/*.md")),
                ("codex", codex_home, ("AGENTS.md", "memories/**/*")))
    found: list[dict[str, Any]] = []
    for source, root, globs in patterns:
        for pattern in globs:
            try:
                paths = sorted(root.glob(pattern))
            except OSError:
                continue
            for path in paths:
                try:
                    if not path.is_file():
                        continue
                    stat = path.stat()
                except OSError:
                    continue
                shown = _home_path(path)
                if len(shown) <= 500:
                    found.append({"source": source, "path": shown, "bytes": stat.st_size,
                                  "modifiedAt": iso(datetime.fromtimestamp(stat.st_mtime, timezone.utc))})
    return found[:500]


def full_inventory(now: datetime, codex_home: Path, claude_home: Path) -> dict[str, Any]:
    """一次完整盘点：本机定时任务、近 30 天会话里读过的飞书文档、记忆文件。"""
    sessions, _status = sessions_in(now - FEISHU_LOOKBACK, now, codex_home, claude_home)
    return {"scheduledTasks": scheduled_tasks(), "feishuDocs": feishu_docs(sessions), "memoryFiles": memory_files(claude_home, codex_home)}


def inventory_due(state: dict[str, Any], now: datetime) -> bool:
    last = state.get("inventory_at")
    return not last or now - datetime.fromisoformat(last.replace("Z", "+00:00")) >= INVENTORY_EVERY


# ---------- 上报 ----------

class Api:
    def __init__(self, server: str, token: str, dry_run: bool):
        self.server, self.token, self.dry_run = server.rstrip("/"), token, dry_run

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if self.dry_run:
            sys.stdout.buffer.write(f"POST {path}\n{json.dumps(body, ensure_ascii=False, indent=2)}\n".encode("utf-8"))
            return {"accepted": len(body.get("items", [])), "duplicates": 0}
        request = urllib.request.Request(self.server + path, data=json.dumps(body).encode("utf-8"), method="POST",
                                         headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))


def device_of(state: dict[str, Any]) -> dict[str, str]:
    if not state.get("device_id"):
        state["device_id"] = uuid.uuid4().hex
    name = socket.gethostname()[:80] or "unknown"
    kind = {"Windows": "windows", "Darwin": "macos"}.get(platform.system(), "linux")
    return {"id": state["device_id"], "name": name, "platform": kind}


def source_states(status: dict[str, str], state: dict[str, Any], coverage: datetime) -> list[dict[str, Any]]:
    evidence = state.get("last_new_evidence_at", {})
    return [{"source": source, "status": value, "coverageUntil": iso(coverage) if value == "ok" else None,
             "lastNewEvidenceAt": evidence.get(source), "errorCode": "READ_FAILED" if value == "error" else None}
            for source, value in sorted(status.items())]


def build_reports(kind: str, device: dict[str, str], sessions: list[cs.Session], status: dict[str, str], state: dict[str, Any],
                  start: datetime, end: datetime) -> list[dict[str, Any]]:
    """上报只带工作段；本机清单随心跳走，天枢没同意采集、上报被拒时清单照样送到。"""
    items = [to_item(session, device["id"], start, end) for session in sessions]
    chunks = [items[i:i + MAX_ITEMS] for i in range(0, len(items), MAX_ITEMS)] or [[]]
    return [{"device": device, "version": VERSION, "kind": kind, "windowStart": iso(start), "windowEnd": iso(end),
             "sources": source_states(status, state, end), "items": chunk} for chunk in chunks]


def note_evidence(state: dict[str, Any], sessions: list[cs.Session]) -> None:
    latest = state.setdefault("last_new_evidence_at", {})
    for session in sessions:
        source, moment = SOURCE[session.tool], iso(max(session.times()))
        if moment > latest.get(source, ""):
            latest[source] = moment


def run(mode: str, args: argparse.Namespace) -> int:
    config = load_json(args.config, {})
    if not config.get("server"):
        raise SystemExit(f"缺天枢地址：在 {args.config} 写 {{\"server\": \"https://天枢地址\"}}")
    api = Api(config["server"], "" if args.dry_run else read_token(config), args.dry_run)
    state = load_json(args.state, {})
    device = device_of(state)
    tz = datetime.now().astimezone().tzinfo
    now = (args.now or datetime.now(timezone.utc)).astimezone(tz)
    end = now - SETTLE
    today = datetime.combine(now.date(), time(0), tzinfo=tz)
    eod_at = datetime.combine(now.date(), time.fromisoformat(config.get("eod_time", "20:30")), tzinfo=tz)

    def flush() -> bool:
        """发出待发的上报；发不出去就留着，下次原样重发（client_event_id 不变，服务端按幂等只记一次）。
        天枢返回 403（本人还没同意采集）时停在这里，内容留在本机，返回 False；其他错误照旧往上抛。"""
        while state.get("pending"):
            report = state["pending"][0]
            try:
                result = api.post("/api/collector/reports", report)
            except urllib.error.HTTPError as error:
                if error.code != 403:
                    raise
                print("天枢那边还没同意采集，待发的工作段先留在本机", file=sys.stderr)
                return False
            state["pending"].pop(0)
            if not args.dry_run:
                save_json(args.state, state)
            print(f"{report['kind']}：{report['windowStart']}–{report['windowEnd']} 新记 {result.get('accepted')} 段，重放 {result.get('duplicates')} 段")
        return True

    def send(kind: str, start: datetime, stop: datetime, sessions: list[cs.Session], status: dict[str, str]) -> bool:
        note_evidence(state, sessions)
        state["pending"] = ((state.get("pending") or []) + build_reports(kind, device, sessions, status, state, start, stop))[-MAX_PENDING:]
        state["watermark"] = iso(stop)
        if not args.dry_run:
            save_json(args.state, state)  # 先连同水位线落盘再发：发到一半断了，下次原样重发，不会换 id 重整理
        return flush()

    flush()  # 上次没发完的先发

    watermark = datetime.fromisoformat(state["watermark"].replace("Z", "+00:00")).astimezone(tz) if state.get("watermark") else today
    watermark = max(watermark, today - timedelta(days=CATCHUP_DAYS))
    sent = False

    # 2. 错过的时段补跑：水位线停在今天以前（电脑关机、睡眠），先把以前的补上。
    if watermark < today:
        sessions, status = sessions_in(watermark, today, args.codex_home, args.claude_home)
        if sessions:
            send("catchup", watermark, today, sessions, status)
        state["watermark"] = iso(today)
        state["last_eod_date"] = max(state.get("last_eod_date", ""), (today - timedelta(days=1)).date().isoformat())
        watermark = today

    # 3. 今天：有新活动且距上次整理满 3 小时，或到了收工时间，或一键同步，才整理一次。
    sessions, status = sessions_in(watermark, end, args.codex_home, args.claude_home)
    last_digest = datetime.fromisoformat(state["last_digest_at"].replace("Z", "+00:00")) if state.get("last_digest_at") else None
    eod_due = now >= eod_at and state.get("last_eod_date") != now.date().isoformat()
    digest_due = bool(sessions) and (last_digest is None or now - last_digest >= DIGEST_EVERY)
    if mode == "sync" or eod_due or digest_due:
        state["last_digest_at"] = iso(now)
        if eod_due:
            state["last_eod_date"] = now.date().isoformat()
        sent = send("eod" if eod_due else "digest", watermark, end, sessions, status)
    elif not sessions:
        state["watermark"] = iso(end)  # 没有新活动：信息截至推进到现在
    else:
        note_evidence(state, sessions)

    # 4. 今天没发出上报，或者到了每天盘点的时候，就发心跳：带上各来源的信息截至，盘点时带上本机清单。
    take_inventory = inventory_due(state, now)
    if not sent or take_inventory:
        coverage = datetime.fromisoformat(state["watermark"].replace("Z", "+00:00"))
        beat: dict[str, Any] = {"device": device, "version": VERSION, "sources": source_states(status, state, coverage)}
        if take_inventory:
            beat["inventory"] = full_inventory(now, args.codex_home, args.claude_home)
        api.post("/api/collector/heartbeat", beat)
        if take_inventory:
            state["inventory_at"] = iso(now)
    if not args.dry_run:
        save_json(args.state, state)
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="本机采集器：读本机会话，上报到天枢。")
    parser.add_argument("mode", choices=["check", "sync"], help="check：定时轻量检查；sync：一键同步，现在就整理一次")
    parser.add_argument("--dry-run", action="store_true", help="只打印要发的内容，不联网、不改状态")
    parser.add_argument("--config", type=Path, default=HOME / "collector.json")
    parser.add_argument("--state", type=Path, default=HOME / "daily-state.json")
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--claude-home", type=Path, default=Path.home() / ".claude")
    parser.add_argument("--now", type=lambda text: datetime.fromisoformat(text.replace("Z", "+00:00")), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        return run(args.mode, args)
    except urllib.error.HTTPError as error:
        print(f"天枢返回 {error.code}：{'令牌无效或已撤销，请重新生成采集器令牌' if error.code == 401 else error.reason}", file=sys.stderr)
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        print(f"连不上天枢，下次检查时重试：{getattr(error, 'reason', error)}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
