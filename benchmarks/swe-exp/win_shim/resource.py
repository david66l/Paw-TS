"""Windows shim so swebench can import (resource is Unix-only).

Place this directory on PYTHONPATH before swebench imports.
"""

from __future__ import annotations

RLIMIT_STACK = 3
RLIMIT_NOFILE = 7
RLIM_INFINITY = -1


def setrlimit(*_a, **_k):  # noqa: ANN001
    return None


def getrlimit(*_a, **_k):  # noqa: ANN001
    return (RLIM_INFINITY, RLIM_INFINITY)
