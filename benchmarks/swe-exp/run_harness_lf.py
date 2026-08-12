"""Windows launcher for SWE-bench Docker evaluation.

pathlib.Path.write_text uses the host newline convention. On Windows that
turns the generated Linux /eval.sh into CRLF, so every command inside the
container receives a trailing ``\r``. Force LF for harness-generated text
artifacts, then execute the official module unchanged.
"""

from __future__ import annotations

import pathlib
import runpy
import sys
import builtins


if sys.platform == "win32":
    sys.path.insert(0, str(pathlib.Path(__file__).with_name("win_shim")))


_original_write_text = pathlib.Path.write_text


def _write_text_lf(
    self: pathlib.Path,
    data: str,
    encoding: str | None = None,
    errors: str | None = None,
    newline: str | None = None,
) -> int:
    return _original_write_text(
        self,
        data,
        encoding="utf-8" if encoding is None else encoding,
        errors=errors,
        newline="\n" if newline is None else newline,
    )


pathlib.Path.write_text = _write_text_lf  # type: ignore[method-assign]

_original_open = builtins.open


def _open_utf8(file, mode="r", *args, **kwargs):
    # Official harness leaves encoding implicit for test-output logs, which is
    # GBK on this Windows host. Keep binary opens untouched; make text logs
    # deterministic and able to store replacement characters.
    if "b" not in mode and "encoding" not in kwargs:
        kwargs["encoding"] = "utf-8"
    return _original_open(file, mode, *args, **kwargs)


builtins.open = _open_utf8

# Some historical test suites print bytes in their locale encoding. The
# upstream Windows harness decodes Docker output with strict UTF-8 and turns a
# valid test run into an infrastructure error on the first invalid byte.
# Preserve all decodable output and replace only malformed bytes; test-status
# markers remain ASCII and are therefore unaffected.
from swebench.harness import docker_utils  # noqa: E402


def _exec_run_with_tolerant_decode(container, cmd, timeout):
    import threading
    import time

    exec_result = b""
    exec_id = None
    exception = None

    def run_command():
        nonlocal exec_result, exec_id, exception
        try:
            exec_id = container.client.api.exec_create(container.id, cmd)["Id"]
            for chunk in container.client.api.exec_start(exec_id, stream=True):
                exec_result += chunk
        except Exception as exc:  # pragma: no cover - Docker edge path
            exception = exc

    thread = threading.Thread(target=run_command)
    start_time = time.time()
    thread.start()
    thread.join(timeout)
    if exception:
        raise exception
    timed_out = thread.is_alive()
    if timed_out and exec_id is not None:
        exec_pid = container.client.api.exec_inspect(exec_id)["Pid"]
        container.exec_run(f"kill -TERM {exec_pid}", detach=True)
    return exec_result.decode("utf-8", errors="replace"), timed_out, time.time() - start_time


docker_utils.exec_run_with_timeout = _exec_run_with_tolerant_decode
runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")
