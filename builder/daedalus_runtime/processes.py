"""Bounded cleanup for leaf-tool child processes started in their own session."""

import os
import signal


def kill_process_group(process) -> None:
    """Kill a ``start_new_session=True`` child and every process in its group.

    The group ID is the original child's PID even after that leader exits.
    """
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


async def reap_process(process) -> None:
    """Wait for the child itself, not for every holder of its output pipes.

    On Python 3.12, ``Process.wait()`` and ``communicate()`` also wait for
    stdout/stderr EOF. A descendant that escaped the process group (``setsid``
    plus ``fork``) survives the group kill and can hold those pipes open
    indefinitely. Close our read ends first, as the Rust runtime drops its
    pipes before waiting; the exit status still comes from the child watcher.
    asyncio exposes the pipe transports only through the subprocess transport.
    """
    transport = getattr(process, "_transport", None)
    if transport is not None:
        for fd in (1, 2):
            pipe = transport.get_pipe_transport(fd)
            if pipe is not None:
                pipe.close()
    await process.wait()
