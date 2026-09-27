"""Load `.env` the way the TypeScript entry points do.

Node's scripts call `loadEnvFile()`, so running one of them picks `.env` up
automatically. Python has no equivalent, and importing this module gives these
scripts the same behaviour: connection strings and API keys live in `.env`, and
nothing has to be exported by hand first.

Variables already set in the environment win, so a one-off override on the
command line still works:

    DATABASE_URL=... python3 build_graph.py
"""

from __future__ import annotations

import os
from pathlib import Path

# orgforge_kb/ sits directly under the repository root, where .env lives.
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load() -> None:
    """Read the repository's `.env` into the environment, if it exists."""
    path = Path(os.environ.get("ORGFORGE_ENV_FILE", ENV_FILE))
    if not path.is_file():
        return
    try:
        from dotenv import load_dotenv
    except ImportError:
        _load_without_dependency(path)
        return
    load_dotenv(path, override=False)


def _load_without_dependency(path: Path) -> None:
    """A minimal fallback for when python-dotenv is not installed.

    Handles what this project's `.env` actually contains: comments, blank lines,
    an optional `export` prefix, and values that may be quoted.
    """
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(name, value)


load()
