#!/usr/bin/env python3
"""Checks on the guides themselves (D-07). Run from the repository root:

    python3 scripts/check_docs.py

It fails when

- a Markdown link in README.md, docs/ or install/ points at a file that is
  not in the repository, or at a heading that the target file does not have;
- a guide names a `./tradingapp.sh` subcommand that the script does not
  take.

Links to other sites are not fetched. Text inside code fences is not read
for links, but is read for commands, since that is where most of them are.
"""

from __future__ import annotations

import glob
import os
import re
import sys

# Older plans kept for the record. They name files that have since moved, so
# only their anchors are checked.
HISTORICAL = {os.path.join("docs", "plans", "GAP_ANALYSIS.md")}

LINK = re.compile(r"\]\(([^)\s]+)\)")
FENCE = re.compile(r"```.*?```", re.S)
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
COMMAND = re.compile(r"tradingapp\.sh[ \t]+([a-z][a-z-]*)")


def slug(heading: str) -> str:
    """A heading's anchor, as GitHub makes it."""
    text = re.sub(r"`", "", heading.strip().lower())
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(path: str) -> set[str]:
    seen: dict[str, int] = {}
    out: set[str] = set()
    fenced = False
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.lstrip().startswith("```"):
                fenced = not fenced
            if fenced:
                continue
            match = HEADING.match(line)
            if match:
                name = slug(match.group(2))
                count = seen.get(name, 0)
                seen[name] = count + 1
                out.add(name if count == 0 else f"{name}-{count}")
    return out


def guides(root: str) -> list[str]:
    found = glob.glob(os.path.join(root, "docs", "**", "*.md"), recursive=True)
    found += glob.glob(os.path.join(root, "install", "*.md"))
    readme = os.path.join(root, "README.md")
    if os.path.exists(readme):
        found.append(readme)
    return sorted(found)


def check_links(root: str) -> list[str]:
    problems: list[str] = []
    cache: dict[str, set[str]] = {}
    for path in guides(root):
        shown = os.path.relpath(path, root)
        with open(path, encoding="utf-8") as handle:
            text = FENCE.sub("", handle.read())
        for match in LINK.finditer(text):
            target = match.group(1)
            if re.match(r"^(https?:|mailto:)", target):
                continue
            file_part, _, fragment = target.partition("#")
            resolved = (
                os.path.normpath(os.path.join(os.path.dirname(path), file_part))
                if file_part
                else path
            )
            if not os.path.exists(resolved):
                if shown not in HISTORICAL:
                    problems.append(f"{shown}: no such file: {target}")
                continue
            if fragment and resolved.endswith(".md"):
                if fragment not in cache.setdefault(resolved, anchors(resolved)):
                    problems.append(f"{shown}: no such heading: {target}")
    return problems


def subcommands(script: str) -> set[str]:
    """Every word `tradingapp.sh` takes as its first argument: the labels of
    its top-level `case` blocks."""
    names: set[str] = set()
    with open(script, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    # From the commands themselves on: the block of old names before them
    # is not for the guides to use.
    start = next(i for i, line in enumerate(lines) if line.startswith("# Commands that talk to"))
    joined = "\n".join(lines[start:]).replace("\\\n", " ")
    for line in joined.splitlines():
        match = re.match(
            r"^    ([a-z-]+(?:\s*\|\s*[a-z-]+)*)(?:\s*\|\s*--?[a-z-]+)*(?:\s*\|\s*\"\")?\)", line
        )
        if match:
            names.update(part.strip() for part in match.group(1).split("|"))
    return names


def check_commands(root: str) -> list[str]:
    script = os.path.join(root, "tradingapp.sh")
    known = subcommands(script)
    problems: list[str] = []
    for path in guides(root):
        shown = os.path.relpath(path, root)
        if shown in HISTORICAL:
            continue
        with open(path, encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                for match in COMMAND.finditer(line):
                    if match.group(1) not in known:
                        problems.append(
                            f"{shown}:{number}: tradingapp.sh has no '{match.group(1)}' command"
                        )
    return problems


def main(root: str = ".") -> int:
    problems = check_links(root) + check_commands(root)
    for problem in problems:
        print(problem)
    count = len(guides(root))
    if problems:
        print(f"{len(problems)} problem(s) in {count} guides")
        return 1
    print(f"{count} guides: links, headings and tradingapp.sh commands all check out")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
