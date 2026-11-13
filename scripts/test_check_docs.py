"""The docs checker finds what it is there to find.

    python3 -m unittest scripts/test_check_docs.py
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import check_docs  # noqa: E402

SCRIPT = """#!/usr/bin/env bash
case "${1:-}" in
    setup) set -- install "${@:2}" ;;
esac

# Commands that talk to Docker first make sure this shell can.
case "${1:-}" in
    deploy | restart | \\
        fix)
        ensure_docker_access
        ;;
esac

case "${1:-}" in
    install)
        install
        ;;
    doctor)
        doctor
        ;;
    help | --help | -h | "")
        show_usage
        ;;
esac
"""


def site(files):
    root = tempfile.mkdtemp()
    for name, text in {"tradingapp.sh": SCRIPT, **files}.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
    return root


class CheckDocs(unittest.TestCase):
    def test_a_clean_set_of_guides_passes(self):
        root = site(
            {
                "README.md": "See [install](docs/INSTALL.md#2-app-server-ct-110).\n",
                "docs/INSTALL.md": (
                    "# Install\n\n## 2. App server (CT 110)\n\n"
                    "Run `./tradingapp.sh install`, then [check](#check).\n\n"
                    "```bash\n./tradingapp.sh doctor\n```\n\n## Check\n\n## Check\n\n"
                    "The [second](#check-1) and [a site](https://example.com/x).\n"
                ),
            }
        )
        self.assertEqual(check_docs.check_links(root) + check_docs.check_commands(root), [])
        self.assertEqual(check_docs.main(root), 0)

    def test_a_missing_file_and_a_missing_heading_are_reported(self):
        root = site(
            {
                "docs/A.md": "# A\n\n[gone](B.md) and [no heading](#nope) and [ok](#a).\n",
                "docs/plans/GAP_ANALYSIS.md": "# Old\n\n[moved](../gone.md) and [bad](#nope).\n",
            }
        )
        problems = check_docs.check_links(root)
        self.assertEqual(len(problems), 3)
        self.assertTrue(any("A.md: no such file: B.md" in p for p in problems))
        self.assertTrue(any("A.md: no such heading: #nope" in p for p in problems))
        # A historical plan may name a moved file, but not a missing heading.
        self.assertTrue(any("GAP_ANALYSIS.md: no such heading" in p for p in problems))
        self.assertEqual(check_docs.main(root), 1)

    def test_a_link_inside_a_code_fence_is_not_read(self):
        root = site({"docs/A.md": "# A\n\n```md\n[x](nowhere.md)\n```\n"})
        self.assertEqual(check_docs.check_links(root), [])

    def test_an_unknown_or_retired_command_is_reported(self):
        root = site(
            {
                "docs/A.md": (
                    "# A\n\n```bash\n./tradingapp.sh restart\n./tradingapp.sh frobnicate\n```\n"
                    "Run `./tradingapp.sh setup` and `tradingapp.sh fix`.\n"
                )
            }
        )
        problems = check_docs.check_commands(root)
        self.assertEqual(len(problems), 2)
        self.assertIn("docs/A.md:5: tradingapp.sh has no 'frobnicate' command", problems[0])
        self.assertIn("'setup'", problems[1])

    def test_the_commands_are_read_from_the_script(self):
        root = site({})
        names = check_docs.subcommands(os.path.join(root, "tradingapp.sh"))
        self.assertTrue({"deploy", "restart", "fix", "install", "doctor", "help"} <= names)
        self.assertNotIn("setup", names)


if __name__ == "__main__":
    unittest.main()
