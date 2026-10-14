"""Validate date invariants, not effort, resource feasibility or business quality."""
import argparse
import calendar
import json
import re
from datetime import date
from pathlib import Path


def date_range(value):
    if not isinstance(value, str):
        raise ValueError("缺少具体日期")
    match = re.fullmatch(
        r"\s*(\d{4}-\d{2}-\d{2})(?:\s*(?:—|–|~|至|到|\s-\s)\s*(\d{4}-\d{2}-\d{2}))?\s*",
        value,
    )
    if not match:
        raise ValueError("日期须为YYYY-MM-DD或两个日期组成的区间，不混入说明")
    start = date.fromisoformat(match[1])
    end = date.fromisoformat(match[2] or match[1])
    if start > end:
        raise ValueError("开始日晚于结束日")
    return start, end


def validate(plan):
    issues = []
    period = plan.get("period") or plan.get("input", {}).get("period")
    try:
        if not isinstance(period, str) or not re.fullmatch(r"\d{4}-\d{2}", period):
            raise ValueError("须提供period: YYYY-MM")
        year, month = map(int, period.split("-"))
        expected = date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])
    except (ValueError, TypeError, calendar.IllegalMonthError) as error:
        return {"passed": False, "issues": [{"object": "period", "problem": str(error)}]}

    def error(label, problem):
        issues.append({"object": label, "problem": problem})

    def span(node, label):
        try:
            return date_range(node.get("time"))
        except (ValueError, TypeError) as exc:
            error(label, str(exc))
            return None

    def children(node, field, label):
        value = node.get(field, [])
        if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
            error(label, field + "必须是对象数组")
            return []
        return value

    units = plan.get("raw", plan.get("units"))
    if not isinstance(units, list) or not units:
        error("plan", "须提供非空raw或units数组")
        units = []
    for index, unit in enumerate(units):
        if not isinstance(unit, dict):
            error(str(index), "PO必须是对象")
            continue
        label = str(unit.get("name") or unit.get("key") or index)
        po = span(unit, label + "/PO")
        if po and po != expected:
            error(label + "/PO", "PO必须覆盖所属月份第一日至最后一日")
        for mi, mission in enumerate(children(unit, "missions", label)):
            ml = label + "/" + str(mission.get("title") or f"Mission {mi + 1}")
            ms = span(mission, ml)
            tasks = children(mission, "tasks", ml)
            task_spans = []
            for ti, task in enumerate(tasks):
                tl = ml + "/" + str(task.get("title") or f"Task {ti + 1}")
                ts = span(task, tl)
                if ts:
                    task_spans.append(ts)
                for ai, activity in enumerate(children(task, "activities", tl)):
                    al = tl + "/" + str(activity.get("title") or f"Activity {ai + 1}")
                    ac = span(activity, al)
                    if ac and ts and (ac[0] < ts[0] or ac[1] > ts[1]):
                        error(al, "Activity超出所属Task时间")
            if tasks and len(task_spans) == len(tasks) and ms:
                computed = min(s[0] for s in task_spans), max(s[1] for s in task_spans)
                if ms != computed:
                    error(ml, "Mission必须等于Task首尾：" + "—".join(d.isoformat() for d in computed))
    return {"passed": not issues, "issues": issues,
            "scope": "仅检查日期结构；不证明工期、容量、依赖或业务结果可行"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
        if not isinstance(plan, dict):
            raise ValueError("计划必须是JSON对象")
        report = validate(plan)
    except (OSError, ValueError, TypeError) as error:
        report = {"passed": False, "issues": [{"object": "plan", "problem": str(error)}]}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
