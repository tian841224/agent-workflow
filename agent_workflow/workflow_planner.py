"""Composable workflow capability planning with conservative legacy fallback.

Two-layer selection:

* outer -- whether a capability runs at all (``candidate`` / ``suppress_when``)
* inner -- which of its steps run, from task complexity and impact (``steps[].when``)

Facts carry their provenance. Declared facts (agent-written frontmatter) may only
escalate; suppression requires observed facts collected from the worktree.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from .protocol import write_json


POLICY_PATH = Path(__file__).resolve().parent.parent / "schemas" / "workflow-policy.json"
UNKNOWN = object()
OBSERVED = "observed"
DECLARED = "declared"

DECLARED_FACT_KEYS = (
    "impact_scope", "impact_effect", "impact_confidence", "schema_operation",
    "schema_constraint_change", "data_transform", "has_consumer", "logic_change",
    "public_api_change", "destructive_operation",
)

COMPLEXITY_HINTS = {"multi_path", "shared_state", "external_boundary"}

CODE_SUFFIXES = {
    ".go", ".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".java", ".cs", ".rb", ".php",
    ".rs", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".scala", ".ex", ".erl",
}
SKIP_DIRS = {".git", "vendor", "node_modules", "dist", "build", "docs", "__pycache__"}
GIT_EXCLUDES = (":!*.sql", ":!vendor/**", ":!node_modules/**", ":!dist/**", ":!build/**", ":!docs/**")
CODE_PATHSPEC = tuple(f"*{suffix}" for suffix in sorted(
    CODE_SUFFIXES))
SYMBOL_ANALYSIS_SUFFIXES = {
    ".go", ".py", ".ts", ".tsx", ".js", ".jsx", ".vue", ".java", ".cs", ".rb", ".php", ".rs", ".kt", ".swift",
}
EMBEDDED_DDL = re.compile(
    r"\b(?:ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|CREATE\s+INDEX|AutoMigrate|AddColumn|add_column|change_column)\b",
    re.IGNORECASE,
)


def planner_enabled(task: Mapping[str, Any]) -> bool:
    return bool(str(task.get("workflow_decision", "")).strip())


def main_controlled(task: Mapping[str, Any]) -> bool:
    return str(task.get("workflow_mode", "")).casefold() == "main"


def manual_plan(task: Mapping[str, Any], policy_path: str | Path = POLICY_PATH) -> dict[str, Any]:
    """Build exactly the capabilities selected by the main conversation."""
    policy = _load_policy(policy_path)
    requested = {str(name) for name in task.get("workflow_request", [])}
    capabilities = {str(item["name"]): item for item in policy["capabilities"]}
    selected = [{"name": name, "kind": str(item["kind"]), "section": str(item["section"]),
                 "steps": list(item.get("steps", [])), "waived_dimensions": [],
                 "reason": "selected by the main conversation"}
                for name, item in capabilities.items() if name in requested]
    order = _order([item["name"] for item in selected],
                   {str(item["name"]): list(item.get("order_after", [])) for item in policy["capabilities"]})
    selected.sort(key=lambda item: order.index(item["name"]))
    roles = [item["name"] for item in selected if item["kind"] == "role"]
    profile = "direct" if not selected else ("elevated" if "adversarial" in roles else "standard" if roles else "light")
    return {"version": policy["version"], "selected": selected, "suppressed": [], "unknown": [], "order": order,
            "roles": roles,
            "sections": sorted({item["section"] for item in selected if item["kind"] == "evidence"}),
            "baseline": policy.get("baseline", []), "profile": profile,
            "final_action": "direct" if not selected else "workflow", "facts": {},
            "complexity": {"declared": [], "observed": [], "effective": [], "analysis_coverage": "not-used"}}


def _load_policy(path: str | Path = POLICY_PATH) -> dict[str, Any]:
    policy = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if policy.get("version") != 3 or not isinstance(policy.get("capabilities"), list):
        raise ValueError("workflow policy must declare version 3 and capabilities")
    names = [item.get("name") for item in policy["capabilities"]]
    if any(not isinstance(name, str) or not name for name in names) or len(names) != len(set(names)):
        raise ValueError("workflow capabilities must have unique non-empty names")
    known = set(names)
    seen_steps: set[str] = set()
    for item in policy["capabilities"]:
        if item.get("kind") not in {"evidence", "role"}:
            raise ValueError(f"workflow capability needs kind evidence|role: {item.get('name')}")
        if not str(item.get("section", "")).strip():
            raise ValueError(f"workflow capability needs a section: {item.get('name')}")
        for dependency in item.get("order_after", []):
            if dependency not in known:
                raise ValueError(f"workflow capability has unknown order_after: {dependency}")
        for step in item.get("steps", []):
            step_id = str(step.get("id", ""))
            if not re.fullmatch(r"[A-Z]{2}[0-9]+", step_id):
                raise ValueError(f"workflow step needs an id like SC1: {step_id!r}")
            if step_id in seen_steps:
                raise ValueError(f"duplicate workflow step id: {step_id}")
            seen_steps.add(step_id)
    return policy


def _task_type(task: Mapping[str, Any]) -> str:
    explicit = str(task.get("task_type", "")).strip().casefold()
    if explicit:
        return explicit
    flags = {str(value).casefold() for value in task.get("risk_flags", [])}
    if "schema" in flags:
        return "schema"
    if "migration" in flags:
        return "migration"
    return str(task.get("change_kind", "")).strip().casefold()


def _normalize(value: Any) -> Any:
    if isinstance(value, str) and value.strip().casefold() in {"unknown", "unclear", ""}:
        return UNKNOWN
    return value


def build_facts(task: Mapping[str, Any], declared: Mapping[str, Any] | None = None,
                observed: Mapping[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """Merge declared and observed facts, keeping provenance. Observed wins."""
    facts: dict[str, dict[str, Any]] = {}
    for source, values in ((DECLARED, {key: task[key] for key in DECLARED_FACT_KEYS if key in task}),
                           (DECLARED, dict(declared or {})),
                           (OBSERVED, dict(observed or {}))):
        for name, raw in values.items():
            value = _normalize(raw)
            if value is UNKNOWN:
                facts.pop(name, None)
                continue
            facts[name] = {"value": value, "source": source}
    return facts


def _rank(policy: Mapping[str, Any], kind: str, value: Any) -> int | None:
    table = policy.get(f"{kind}_rank", {})
    return table.get(str(value).casefold())


def _effective_scope(policy: Mapping[str, Any], task: Mapping[str, Any],
                     facts: Mapping[str, dict[str, Any]]) -> str:
    """Observed call sites may raise the declared scope, never lower it."""
    declared = str(task.get("impact_scope", ""))
    entry = facts.get("symbol_reach")
    if not entry or entry["source"] != OBSERVED:
        return declared
    observed = str(entry["value"])
    if observed not in policy.get("scope_rank", {}):
        return declared
    declared_rank = _rank(policy, "scope", declared)
    if declared_rank is None:
        return observed
    return observed if _rank(policy, "scope", observed) > declared_rank else declared


def _member(value: Any, expected: list[Any]) -> bool:
    if isinstance(value, str):
        return value.casefold() in {str(item).casefold() for item in expected}
    if isinstance(value, (list, tuple, set, frozenset)):
        actual = {str(item).casefold() for item in value}
        return bool(actual.intersection(str(item).casefold() for item in expected))
    return value in expected


def _condition(policy: Mapping[str, Any], task: Mapping[str, Any],
               facts: Mapping[str, dict[str, Any]], condition: Mapping[str, Any],
               trust_declared: bool) -> bool | None:
    """Evaluate one condition to True / False / None (cannot be proven)."""
    if "not" in condition:
        inner = _condition(policy, task, facts, condition["not"], trust_declared)
        return None if inner is None else not inner
    if condition.get("always") is True:
        return True
    if "fact" in condition:
        entry = facts.get(str(condition["fact"]))
        if entry is None:
            return None
        if not trust_declared and entry["source"] != OBSERVED:
            return None
        return _member(entry["value"], list(condition.get("equals", [])))
    # Everything below is declared task metadata: it may escalate, never suppress.
    if not trust_declared:
        return None
    if "code_change" in condition:
        return task.get("code_change") is condition["code_change"]
    if "task_type" in condition:
        return _task_type(task) in {str(item).casefold() for item in condition["task_type"]}
    if "change_kind" in condition:
        return _member(str(task.get("change_kind", "")), list(condition["change_kind"]))
    if "risk_flags" in condition:
        flags = {str(value).casefold() for value in task.get("risk_flags", [])}
        return bool(flags.intersection(str(item).casefold() for item in condition["risk_flags"]))
    if "impact_effect" in condition:
        return _member(str(task.get("impact_effect", "")), list(condition["impact_effect"]))
    if "impact_scope" in condition:
        return _member(_effective_scope(policy, task, facts), list(condition["impact_scope"]))
    for key, kind in (("impact_scope_at_least", "scope"), ("impact_effect_at_least", "effect")):
        if key in condition:
            value = _effective_scope(policy, task, facts) if kind == "scope" else task.get("impact_effect", "")
            actual = _rank(policy, kind, value)
            threshold = _rank(policy, kind, condition[key])
            if actual is None or threshold is None:
                return None
            return actual >= threshold
    return False


def _groups(policy: Mapping[str, Any], task: Mapping[str, Any], facts: Mapping[str, dict[str, Any]],
            groups: list[list[Mapping[str, Any]]], trust_declared: bool) -> bool | None:
    """OR across groups, AND inside a group. None when nothing matched but something is unproven."""
    unproven = False
    for group in groups:
        states = [_condition(policy, task, facts, condition, trust_declared) for condition in group]
        if states and all(state is True for state in states):
            return True
        if any(state is None for state in states) and not any(state is False for state in states):
            unproven = True
    return None if unproven else False


def _candidate(policy: Mapping[str, Any], task: Mapping[str, Any], capability: Mapping[str, Any],
               facts: Mapping[str, dict[str, Any]]) -> bool:
    candidate = capability.get("candidate", {})
    flags = {str(value).casefold() for value in task.get("risk_flags", [])}
    checks: list[bool] = []
    if "code_change" in candidate:
        checks.append(task.get("code_change") is candidate["code_change"])
    if candidate.get("task_types"):
        checks.append(_task_type(task) in {str(value).casefold() for value in candidate["task_types"]})
    if candidate.get("change_kinds"):
        checks.append(_member(str(task.get("change_kind", "")), list(candidate["change_kinds"])))
    if candidate.get("risk_flags"):
        checks.append(bool(flags.intersection(str(value).casefold() for value in candidate["risk_flags"])))
    if candidate.get("impact_effect"):
        checks.append(_member(str(task.get("impact_effect", "")), list(candidate["impact_effect"])))
    if candidate.get("impact_scope"):
        checks.append(_member(_effective_scope(policy, task, facts), list(candidate["impact_scope"])))
    dynamic = capability.get("candidate_when", [])
    if dynamic:
        state = _groups(policy, task, facts, dynamic, trust_declared=True)
        checks.append(state is True)
    return any(checks)


def _steps(policy: Mapping[str, Any], task: Mapping[str, Any], facts: Mapping[str, dict[str, Any]],
           capability: Mapping[str, Any]) -> list[dict[str, str]]:
    """Inner selection. An unproven condition keeps the step: unknown is never treated as no."""
    chosen = []
    for step in capability.get("steps", []):
        state = _groups(policy, task, facts, step.get("when", []), trust_declared=True)
        if state is not False:
            chosen.append({"id": str(step["id"]), "title": str(step.get("title", ""))})
    return chosen


def _waived_dimensions(policy: Mapping[str, Any], task: Mapping[str, Any],
                       facts: Mapping[str, dict[str, Any]], capability: Mapping[str, Any]) -> list[str]:
    """Review dimensions that observed evidence makes vacuous.

    Only the dimensions that exist to trace blast radius may be waived, and only when the
    worktree proves there is none. Correctness, security and quality are never waived --
    'nothing calls this' says nothing about whether the code is right.
    """
    scope = _effective_scope(policy, task, facts)
    waived: set[str] = set()
    for waiver in capability.get("dimension_waivers", []):
        limit = _rank(policy, "scope", waiver.get("max_scope", "module"))
        actual = _rank(policy, "scope", scope)
        if limit is None or actual is None or actual > limit:
            continue
        if _groups(policy, task, facts, waiver.get("when", []), trust_declared=False) is True:
            waived.update(str(name) for name in waiver.get("dimensions", []))
    return sorted(waived)


def _decision(policy: Mapping[str, Any], task: Mapping[str, Any],
              facts: Mapping[str, dict[str, Any]], capability: Mapping[str, Any]) -> tuple[str, str]:
    name = str(capability["name"])
    state = _groups(policy, task, facts, capability.get("suppress_when", []), trust_declared=False)
    if state is True:
        return "suppressed", f"observed evidence proves {name} has nothing to check"
    if state is None:
        return "unknown", "suppression could not be proven from observed evidence"
    return "selected", f"{name} is a candidate and no observed evidence suppresses it"


def _predecessors(name: str, order_after: Mapping[str, list[str]], seen: set[str] | None = None) -> set[str]:
    """Transitive closure, so ordering survives an absent intermediate capability."""
    seen = seen if seen is not None else set()
    for dependency in order_after.get(name, []):
        if dependency in seen:
            continue
        seen.add(dependency)
        _predecessors(dependency, order_after, seen)
    return seen


def _order(names: list[str], order_after: Mapping[str, list[str]]) -> list[str]:
    pending = {name: _predecessors(name, order_after) & set(names) for name in names}
    ordered: list[str] = []
    while pending:
        ready = sorted(name for name, deps in pending.items() if not (deps & pending.keys()))
        if not ready:
            raise ValueError("workflow capability order cycle")
        ordered.extend(ready)
        for name in ready:
            pending.pop(name)
    return ordered


def _changed_paths(cwd: str | Path) -> list[str]:
    root = str(cwd)
    commands = [
        ["git", "-C", root, "diff", "--name-only", "HEAD"],
        ["git", "-C", root, "ls-files", "--others", "--exclude-standard"],
    ]
    paths: set[str] = set()
    for command in commands:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if result.returncode != 0:
            continue
        paths.update(line.strip() for line in result.stdout.splitlines() if line.strip())
    return sorted(paths)


def _untracked_paths(cwd: str | Path) -> set[str] | None:
    try:
        result = subprocess.run(["git", "-C", str(cwd), "ls-files", "--others", "--exclude-standard"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def _read(root: Path, paths: list[str]) -> str:
    return "\n".join((root / path).read_text(encoding="utf-8", errors="replace")
                     for path in paths if (root / path).is_file())


def _consumer_hits(root: Path, columns: list[str]) -> Any:
    """Search tracked files with git grep, then the few untracked ones directly.

    git is already a hard dependency here and stays fast on large repositories, where a
    per-file Python walk costs minutes and still proves nothing. Any result other than a
    clean hit or a clean miss is 'unknown' -- a failed search is never a proven miss.
    """
    terms = sorted({term for column in columns for term in _name_variants(column)})
    tracked = _git_grep(root, terms)
    if tracked == "unknown":
        return "unknown"
    untracked = _scan_untracked(root, terms)
    if untracked == "unknown":
        return "unknown"
    return (list(tracked) + list(untracked))[:20]


def _git_grep(root: Path, terms: list[str]) -> Any:
    patterns = [argument for term in terms for argument in ("-e", term)]
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "grep", "-n", "-F", "--max-count", "20", *patterns, "--", *GIT_EXCLUDES],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return "unknown"
    if result.returncode == 0:
        return [line for line in result.stdout.splitlines() if line.strip()][:20]
    return [] if result.returncode == 1 else "unknown"


def _scan_untracked(root: Path, terms: list[str]) -> Any:
    try:
        listing = subprocess.run(["git", "-C", str(root), "ls-files", "--others", "--exclude-standard"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return "unknown"
    if listing.returncode != 0:
        return "unknown"
    paths = [line.strip() for line in listing.stdout.splitlines() if line.strip()]
    candidates = [path for path in paths
                  if Path(path).suffix.casefold() != ".sql"
                  and not SKIP_DIRS.intersection(part.casefold() for part in Path(path).parts[:-1])]
    if len(candidates) > 500:
        return "unknown"
    hits: list[str] = []
    for path in candidates:
        try:
            text = (root / path).read_text(encoding="utf-8", errors="strict")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if any(term in line for term in terms):
                hits.append(f"{path}:{number}:{line.strip()[:120]}")
                if len(hits) >= 20:
                    return hits
    return hits


def _name_variants(column: str) -> list[str]:
    parts = [part for part in column.split("_") if part]
    if not parts:
        return [column]
    camel = parts[0].lower() + "".join(part.capitalize() for part in parts[1:])
    pascal = "".join(part.capitalize() for part in parts)
    return sorted({column, camel, pascal})


SYMBOL_PATTERNS = (
    re.compile(r"\bfunc\s+\([^)]*\)\s*([A-Za-z_]\w*)"),                       # Go method
    re.compile(r"\bfunc\s+([A-Za-z_]\w*)"),                                   # Go function
    re.compile(r"\b(?:def|class)\s+([A-Za-z_]\w*)"),                          # Python / Ruby
    re.compile(r"\btype\s+([A-Za-z_]\w*)"),                                   # Go type
    re.compile(r"\b(?:function|interface|class|enum|struct)\s+([A-Za-z_]\w*)"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*[=:]"),
    re.compile(r"\b(?:public|private|protected|internal|static|override|async)[\w\s<>\[\],]*?\s([A-Za-z_]\w*)\s*\("),
)
# Names too generic to prove anything with: a hit says nothing and a miss even less.
GENERIC_SYMBOLS = {
    "main", "init", "setup", "start", "stop", "close", "open", "read", "write", "parse",
    "value", "index", "data", "list", "item", "name", "error", "result", "config", "client",
    "server", "handler", "handle", "request", "response", "test", "string", "number", "state",
}


# Coupling that does not travel through a function call: persisted rows, cache keys,
# process-wide state, queues. "Nothing calls this" says nothing about any of them.
SHARED_STATE_PATTERNS = (
    re.compile(r"\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|UPSERT|MERGE\s+INTO)\b", re.IGNORECASE),
    re.compile(r"\.(?:Save|Create|Updates?|Delete|Insert|Exec|ExecContext|FirstOrCreate|Upsert)\s*\("),
    re.compile(r"\b(?:redis|Redis|rdb|memcache|Memcache)\b"),
    re.compile(r"\.(?:Set|SetEx|SetNX|HSet|LPush|RPush|SAdd|ZAdd|Incr|IncrBy|Expire|Del)\s*\("),
    re.compile(r"\b(?:sync\.(?:Mutex|RWMutex|Map|Once)|atomic\.\w+|globalThis|localStorage|sessionStorage)\b"),
    re.compile(r"\b(?:WriteFile|os\.Create|ioutil\.WriteFile|open\([^)]*['\"][wa])\b"),
    re.compile(r"\.(?:Publish|Produce|Emit|SendMessage|Enqueue|Broadcast)\s*\("),
)


def _touches_shared_state(diff: str) -> bool:
    for line in diff.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        if any(pattern.search(line[1:]) for pattern in SHARED_STATE_PATTERNS):
            return True
    return False


def _extract_symbols(text: str) -> set[str]:
    found: set[str] = set()
    for line in text.splitlines():
        if line.startswith("@@"):
            line = line.partition("@@")[2].partition("@@")[2]
        elif line.startswith("+") and not line.startswith("+++"):
            line = line[1:]
        else:
            continue
        for pattern in SYMBOL_PATTERNS:
            match = pattern.search(line)
            if match:
                found.add(match.group(1))
                break
    return found


def _changed_symbols(root: Path) -> Any:
    """Symbols whose definition or body this diff touched, from git's own hunk context."""
    try:
        result = subprocess.run(["git", "-C", str(root), "diff", "-U0", "HEAD", "--", *CODE_PATHSPEC],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return "unknown"
    if result.returncode != 0:
        return "unknown"
    shared_state = _touches_shared_state(result.stdout)
    symbols = _extract_symbols(result.stdout)
    if not symbols:
        return {"symbols": set(), "complete": False, "shared_state": shared_state}
    searchable = {name for name in symbols if len(name) >= 5 and name.casefold() not in GENERIC_SYMBOLS}
    # Dropping a generic name only costs us the right to claim "nothing depends on this";
    # whatever survives can still prove that something does.
    complete = len(searchable) == len(symbols) and len(searchable) <= 50
    return {"symbols": set(sorted(searchable)[:50]), "complete": complete, "shared_state": shared_state}


def _symbol_reach(root: Path, symbols: set[str], changed: set[str]) -> Any:
    """Where the changed symbols are referenced from, outside the files that define them."""
    patterns = [argument for name in sorted(symbols) for argument in ("-e", name)]
    try:
        # Only code counts as a call site: prose that merely names a function is not a consumer.
        result = subprocess.run(["git", "-C", str(root), "grep", "-l", "-F", *patterns,
                                 "--", *CODE_PATHSPEC, *GIT_EXCLUDES],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return "unknown"
    if result.returncode not in (0, 1):
        return "unknown"
    outside = {line.strip() for line in result.stdout.splitlines() if line.strip()} - changed
    if not outside:
        return {"scope": "none", "files": []}
    directories = {str(PurePosixPath(path).parent) for path in outside}
    changed_directories = {str(PurePosixPath(path).parent) for path in changed}
    scope = "module" if directories <= changed_directories else "multi_module"
    return {"scope": scope, "files": sorted(outside)[:20]}


def _complexity(task: Mapping[str, Any], facts: Mapping[str, dict[str, Any]]) -> dict[str, Any]:
    """Merge declared escalation hints with observed coupling and coverage facts."""
    declared = {str(value) for value in task.get("complexity_hint", []) if str(value) in COMPLEXITY_HINTS}
    observed: set[str] = set()
    for name, signal in (("has_consumer", "multi_path"), ("shared_state_write", "shared_state"),
                         ("public_api_change", "external_boundary"), ("data_transform", "external_boundary"),
                         ("destructive_operation", "external_boundary")):
        entry = facts.get(name)
        if entry and entry["source"] == OBSERVED and entry["value"] is True:
            observed.add(signal)
    reach = facts.get("symbol_reach")
    if reach and reach["source"] == OBSERVED and reach["value"] in {"module", "multi_module"}:
        observed.add("multi_path")
    schema = facts.get("schema_operation")
    if schema and schema["source"] == OBSERVED and schema["value"] not in {"none", "unknown"}:
        observed.add("external_boundary")
    coverage = facts.get("analysis_coverage")
    if coverage and coverage["source"] == OBSERVED and coverage["value"] != "complete":
        observed.add("uncertain_impact")
    if schema and schema["source"] == OBSERVED and schema["value"] == "unknown":
        observed.add("uncertain_impact")
    if str(task.get("impact_confidence", "high")).casefold() in {"medium", "low"}:
        declared.add("uncertain_impact")
    return {
        "declared": sorted(declared),
        "observed": sorted(observed),
        "effective": sorted(declared | observed),
        "analysis_coverage": coverage["value"] if coverage else "unknown",
    }


def collect_evidence(cwd: str | Path, task: Mapping[str, Any]) -> dict[str, Any]:
    """Collect only facts that can be proven from the current worktree."""
    root = Path(cwd)
    paths = _changed_paths(root)
    evidence: dict[str, Any] = {"changed_paths": paths}
    if not paths:
        return evidence
    code_paths = [path for path in paths if Path(path).suffix.casefold() in CODE_SUFFIXES]
    evidence["logic_change"] = bool(code_paths)
    untracked = _untracked_paths(root)
    suffixes = {Path(path).suffix.casefold() for path in code_paths}
    if not code_paths:
        evidence["analysis_coverage"] = "complete"
    elif untracked is None or any(path in untracked for path in code_paths):
        evidence["analysis_coverage"] = "partial"
    elif not suffixes.issubset(SYMBOL_ANALYSIS_SUFFIXES):
        evidence["analysis_coverage"] = "unsupported"
    if not code_paths:
        evidence["public_api_change"] = False
    else:
        found = _changed_symbols(root)
        if found == "unknown":
            evidence["symbol_reach"] = "unknown"
        else:
            evidence["shared_state_write"] = found["shared_state"]
            evidence["changed_symbols"] = sorted(found["symbols"])
            reach = _symbol_reach(root, found["symbols"], set(code_paths)) if found["symbols"] else "unknown"
            if reach == "unknown" or (reach["scope"] == "none" and not found["complete"]):
                evidence["symbol_reach"] = "unknown"
            else:
                evidence["symbol_reach"] = reach["scope"]
                evidence["symbol_consumers"] = reach["files"]
                evidence["has_consumer"] = reach["scope"] != "none"
            if "analysis_coverage" not in evidence:
                evidence["analysis_coverage"] = "complete" if found["complete"] else "partial"
    sql_paths = [path for path in paths if Path(path).suffix.casefold() == ".sql"]
    embedded = [path for path in code_paths if EMBEDDED_DDL.search(_read(root, [path]))]
    ddl_text = _read(root, sql_paths + embedded)
    if not ddl_text.strip():
        # No DDL in the diff at all, so there is no SQL-level data movement to reason about.
        evidence.setdefault("data_transform", False)
        evidence.setdefault("destructive_operation", False)
        if evidence.get("symbol_reach") == "none":
            # Nothing outside the changed files references these symbols, so they are not a
            # public surface. Anything weaker than a proven miss leaves this unknown.
            evidence.setdefault("public_api_change", False)
        return evidence
    if embedded:
        # DDL outside .sql cannot be classified statement by statement here.
        evidence["schema_operation"] = "unknown"
        return evidence
    destructive = bool(re.search(r"\b(?:DROP|TRUNCATE|RENAME)\b", ddl_text, re.IGNORECASE))
    data_transform = bool(re.search(r"\b(?:INSERT|UPDATE|DELETE|BACKFILL|SELECT\s+INTO)\b", ddl_text, re.IGNORECASE))
    constraint = bool(re.search(r"\b(?:NOT\s+NULL|DEFAULT|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|INDEX|TRIGGER|CONSTRAINT)\b",
                                ddl_text, re.IGNORECASE))
    added = re.findall(r"\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\"]?([A-Za-z_][A-Za-z0-9_]*)", ddl_text, re.IGNORECASE)
    additive = bool(added) and not destructive and not data_transform and not constraint
    evidence.update({
        "schema_operation": "additive_nullable" if additive else "changed",
        "schema_constraint_change": constraint,
        "data_transform": data_transform,
        "destructive_operation": destructive,
    })
    if added:
        hits = _consumer_hits(root, added)
        if hits == "unknown":
            evidence["has_consumer"] = "unknown"
        else:
            evidence["consumer_search"] = list(hits)[:20]
            # Column and symbol searches both answer "does anything else depend on this";
            # a consumer found by either counts, and proving none needs both to be sure.
            previous = evidence.get("has_consumer")
            evidence["has_consumer"] = ("unknown" if previous == "unknown"
                                        else bool(hits) or bool(previous))
    return evidence


def plan_workflows(task: Mapping[str, Any], observed: Mapping[str, Any] | None = None,
                   policy_path: str | Path = POLICY_PATH,
                   declared: Mapping[str, Any] | None = None) -> dict[str, Any]:
    policy = _load_policy(policy_path)
    facts = build_facts(task, declared, observed)
    complexity = _complexity(task, facts)
    if complexity["effective"]:
        facts["complexity_signals"] = {
            "value": complexity["effective"],
            "source": OBSERVED if complexity["observed"] else DECLARED,
        }
    selected: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = []
    for capability in policy["capabilities"]:
        name = str(capability["name"])
        if not _candidate(policy, task, capability, facts):
            continue
        status, reason = _decision(policy, task, facts, capability)
        if status == "suppressed":
            suppressed.append({"name": name, "reason": reason,
                               "evidence": _evidence_for(facts, capability)})
            continue
        record = {
            "name": name,
            "kind": str(capability["kind"]),
            "section": str(capability["section"]),
            "steps": _steps(policy, task, facts, capability),
            "waived_dimensions": _waived_dimensions(policy, task, facts, capability),
            "reason": reason,
        }
        selected.append(record)
        if status == "unknown":
            unknown.append({"name": name, "reason": reason, "evidence": _evidence_for(facts, capability)})
    order_after = {str(item["name"]): list(item.get("order_after", [])) for item in policy["capabilities"]}
    names = [item["name"] for item in selected]
    order = _order(names, order_after)
    selected.sort(key=lambda item: order.index(item["name"]))
    by_name = {item["name"]: item for item in selected}
    roles = [name for name in order if by_name[name]["kind"] == "role"]
    minimum = [str(value) for value in task.get("workflow_request", []) if str(value) in order_after]
    for name in minimum:
        if name in by_name:
            continue
        capability = next(item for item in policy["capabilities"] if item["name"] == name)
        suppressed = [record for record in suppressed if record["name"] != name]
        unknown = [record for record in unknown if record["name"] != name]
        selected.append({"name": name, "kind": str(capability["kind"]), "section": str(capability["section"]),
                         "steps": _steps(policy, task, facts, capability),
                         "waived_dimensions": _waived_dimensions(policy, task, facts, capability),
                         "reason": "requested by the user through workflow_request"})
        by_name[name] = selected[-1]
        order = _order([item["name"] for item in selected], order_after)
        selected.sort(key=lambda item: order.index(item["name"]))
        roles = [item for item in order if by_name[item]["kind"] == "role"]
    sections = sorted({item["section"] for item in selected if item["kind"] == "evidence"})
    return {
        "version": policy["version"],
        "task_type": _task_type(task),
        "selected": selected,
        "suppressed": suppressed,
        "unknown": unknown,
        "order": order,
        "roles": roles,
        "sections": sections,
        "baseline": policy.get("baseline", []),
        "profile": _profile(task, selected, roles),
        "final_action": "direct" if not selected else "workflow",
        "facts": facts,
        "complexity": complexity,
    }


def _evidence_for(facts: Mapping[str, dict[str, Any]], capability: Mapping[str, Any]) -> dict[str, Any]:
    names = {str(condition.get("fact")) for group in capability.get("suppress_when", [])
             for condition in group if "fact" in condition}
    return {name: facts[name] for name in sorted(names) if name in facts}


def _profile(task: Mapping[str, Any], selected: list[dict[str, Any]], roles: list[str]) -> str:
    """Display label derived from the selection. It never drives gate behavior."""
    if not task.get("code_change"):
        return "non-code"
    if not selected:
        return "direct"
    if not roles:
        return "light"
    return "elevated" if "adversarial" in roles else "standard"


def plan_task(task: Mapping[str, Any], policy_path: str | Path = POLICY_PATH,
              cwd: str | Path = "") -> dict[str, Any]:
    raw = task.get("workflow_facts", "")
    declared: Mapping[str, Any] = {}
    if raw and not re.fullmatch(r"<.*>", str(raw).strip()):
        try:
            parsed = json.loads(str(raw))
        except json.JSONDecodeError as exc:
            raise ValueError(f"workflow_facts is not valid JSON: {exc.msg}") from exc
        if not isinstance(parsed, dict):
            raise ValueError("workflow_facts must be a JSON object")
        declared = parsed
    observed = collect_evidence(cwd, task) if cwd else {}
    return plan_workflows(task, observed, policy_path, declared)


def _name(item: Any) -> str:
    return str(item.get("name")) if isinstance(item, Mapping) else str(item)


def decision_projection(plan: Mapping[str, Any]) -> dict[str, Any]:
    """Canonical shape compared between the recorded decision and a fresh plan."""
    projection: dict[str, Any] = {
        "selected": [
            {
                "name": _name(item),
                "kind": str(item.get("kind", "")) if isinstance(item, Mapping) else "",
                "steps": sorted(_name(step) if not isinstance(step, Mapping) else str(step.get("id"))
                                for step in (item.get("steps", []) if isinstance(item, Mapping) else [])),
                "waived_dimensions": sorted(str(name) for name in
                                            (item.get("waived_dimensions", []) if isinstance(item, Mapping) else [])),
            }
            for item in plan.get("selected", [])
        ],
    }
    projection["selected"].sort(key=lambda item: item["name"])
    for key in ("suppressed", "unknown"):
        projection[key] = sorted(_name(item) for item in plan.get(key, []))
    complexity = plan.get("complexity", {})
    projection["complexity"] = {
        "declared": sorted(str(value) for value in complexity.get("declared", [])),
        "observed": sorted(str(value) for value in complexity.get("observed", [])),
        "effective": sorted(str(value) for value in complexity.get("effective", [])),
        "analysis_coverage": str(complexity.get("analysis_coverage", "unknown")),
    }
    return projection


def legacy_profile(code_change: bool, risk_flags: list[str] | None = None,
                   change_kind: str = "", subtask_role: str = "") -> str:
    if not code_change:
        return "non-code"
    if subtask_role in {"coordinator", "worker"}:
        return "elevated"
    if {"authorization", "contract", "cross_feature", "data_write", "financial", "irreversible", "migration", "schema", "unclear_requirements"}.intersection(risk_flags or []):
        return "elevated"
    if change_kind in {"feature", "refactor"}:
        return "elevated"
    return "standard"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-json", required=True)
    parser.add_argument("--facts-json", default="{}")
    parser.add_argument("--policy-path", default=str(POLICY_PATH))
    parser.add_argument("--cwd", default="")
    args = parser.parse_args(argv)
    task = json.loads(args.task_json)
    if args.cwd:
        write_json(plan_task(task, args.policy_path, args.cwd))
    else:
        write_json(plan_workflows(task, json.loads(args.facts_json), args.policy_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
