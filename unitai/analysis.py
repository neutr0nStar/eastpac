"""Cartographer: zero-token static analysis of a Python repository."""
from __future__ import annotations

import ast
import re
from pathlib import Path

SKIP_DIRS = {"__pycache__", ".git", "venv", ".venv", "node_modules", "tests", "test"}

_BRANCH = (ast.If, ast.For, ast.While, ast.Try, ast.With, ast.BoolOp, ast.IfExp,
           ast.ExceptHandler, ast.comprehension, ast.Match if hasattr(ast, "Match") else ast.If)


def _complexity(node: ast.AST) -> int:
    return 1 + sum(isinstance(n, _BRANCH) for n in ast.walk(node))


def _args(fn: ast.FunctionDef) -> list[str]:
    a = fn.args
    names = [x.arg for x in a.posonlyargs + a.args]
    defaults = [None] * (len(names) - len(a.defaults)) + [ast.unparse(d) for d in a.defaults]
    out = []
    for n, d in zip(names, defaults):
        if n in ("self", "cls"):
            continue
        out.append(f"{n}={d}" if d is not None else n)
    if a.vararg:
        out.append("*" + a.vararg.arg)
    if a.kwarg:
        out.append("**" + a.kwarg.arg)
    return out


def analyse_repo(repo: Path) -> dict:
    modules = []
    for path in sorted(repo.rglob("*.py")):
        rel = path.relative_to(repo)
        if any(part in SKIP_DIRS for part in rel.parts) or rel.name.startswith("test_"):
            continue
        src = path.read_text(errors="replace")
        try:
            tree = ast.parse(src)
        except SyntaxError as e:
            modules.append({"path": str(rel), "error": f"SyntaxError: {e}", "loc": src.count("\n")})
            continue
        mod_name = ".".join(rel.with_suffix("").parts)
        if mod_name.endswith(".__init__"):
            mod_name = mod_name[: -len(".__init__")]
        functions, classes, imports, constants = [], [], set(), []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.append({
                    "name": node.name, "args": _args(node), "line": node.lineno,
                    "doc": (ast.get_docstring(node) or "").split("\n")[0],
                    "complexity": _complexity(node), "private": node.name.startswith("_"),
                })
            elif isinstance(node, ast.ClassDef):
                methods, attrs = [], []
                for b in node.body:
                    if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        is_prop = any(getattr(d, "id", None) == "property" for d in b.decorator_list)
                        methods.append({"name": b.name, "args": _args(b), "property": is_prop,
                                        "complexity": _complexity(b)})
                        for n in ast.walk(b):
                            if (isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Store)
                                    and getattr(n.value, "id", None) == "self" and n.attr not in attrs):
                                attrs.append(n.attr)
                classes.append({
                    "name": node.name, "bases": [ast.unparse(b) for b in node.bases],
                    "methods": methods, "attributes": attrs, "line": node.lineno,
                    "doc": (ast.get_docstring(node) or "").split("\n")[0],
                })
            elif isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets):
                for t in node.targets:
                    if t.id.isupper():
                        constants.append(t.id)
            if isinstance(node, ast.Import):
                imports.update(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
        modules.append({
            "path": str(rel), "name": mod_name, "loc": src.count("\n") + 1,
            "functions": functions, "classes": classes, "constants": constants,
            "imports": sorted(imports), "complexity": _complexity(tree),
        })

    names = {m["name"] for m in modules if "name" in m}
    for m in modules:
        m["internal_deps"] = sorted(i for i in m.get("imports", []) if i in names)
        m["external_deps"] = sorted(i for i in m.get("imports", []) if i not in names)

    totals = {
        "modules": len(modules),
        "loc": sum(m["loc"] for m in modules),
        "functions": sum(len(m.get("functions", [])) for m in modules),
        "classes": sum(len(m.get("classes", [])) for m in modules),
        "methods": sum(len(c["methods"]) for m in modules for c in m.get("classes", [])),
    }
    return {"modules": modules, "totals": totals, "language": "Python"}


def _safe(name: str) -> str:
    return re.sub(r"\W", "_", name)


def class_diagram(analysis: dict) -> str:
    lines = ["classDiagram", "  direction LR"]
    rels = []
    for m in analysis["modules"]:
        if "error" in m:
            continue
        mid = _safe(m["name"])
        public = [f for f in m["functions"] if not f["private"]]
        if public:
            lines.append(f"  class {mid} {{")
            lines.append("    <<module>>")
            for f in public:
                lines.append(f"    +{f['name']}({', '.join(a.split('=')[0] for a in f['args'])})")
            lines.append("  }")
        for c in m["classes"]:
            cid = _safe(c["name"])
            members = [f"    -{a}" for a in c["attributes"][:8]]
            for meth in c["methods"]:
                args = ", ".join(a.split("=")[0] for a in meth["args"])
                if meth["name"] == "__init__":
                    members.insert(0, f"    +{cid}({args})")
                elif not meth["name"].startswith("_"):
                    members.append(f"    +{meth['name']}({args})")
            if members:
                lines += [f"  class {cid} {{", *members, "  }"]
            else:
                lines.append(f"  class {cid}")
            for b in c["bases"]:
                if b in ("object",):
                    continue
                rels.append(f"  {_safe(b.split('.')[-1])} <|-- {cid}")
            if public:
                rels.append(f"  {mid} .. {cid}")
        for dep in m["internal_deps"]:
            rels.append(f"  {mid} ..> {_safe(dep)} : imports")
    return "\n".join(lines + rels)


def dependency_graph(analysis: dict) -> str:
    lines = ["flowchart LR"]
    for m in analysis["modules"]:
        mid = _safe(m.get("name", m["path"]))
        n_fn = len(m.get("functions", []))
        n_cls = len(m.get("classes", []))
        lines.append(f'  {mid}["<b>{m["path"]}</b><br/>{m["loc"]} LOC · {n_fn} fn · {n_cls} cls"]')
    for m in analysis["modules"]:
        for dep in m.get("internal_deps", []):
            lines.append(f"  {_safe(m['name'])} --> {_safe(dep)}")
    return "\n".join(lines)


def signatures(analysis: dict) -> str:
    """Compact text outline of the public surface, fed to LLMs instead of whole files."""
    out = []
    for m in analysis["modules"]:
        out.append(f"# {m['path']}  (deps: {', '.join(m.get('internal_deps', [])) or 'none'})")
        for f in m.get("functions", []):
            out.append(f"def {f['name']}({', '.join(f['args'])})" + (f"  # {f['doc']}" if f["doc"] else ""))
        for c in m.get("classes", []):
            out.append(f"class {c['name']}({', '.join(c['bases'])})")
            for meth in c["methods"]:
                prop = "@property " if meth["property"] else ""
                out.append(f"    {prop}def {meth['name']}({', '.join(meth['args'])})")
    return "\n".join(out)
