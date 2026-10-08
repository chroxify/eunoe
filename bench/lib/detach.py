#!/usr/bin/env python3
"""Run a command in its own session, so it outlives the shell that started it.

`nohup` only ignores SIGHUP; a harness that kills the whole process group
still takes the child with it. setsid() detaches properly.

    bench/detach.py <logfile> <command> [args...]
"""
import os
import sys

log, command = sys.argv[1], sys.argv[2:]
if not command:
    sys.exit("usage: detach.py <logfile> <command> [args...]")

if os.fork():  # parent returns to the shell at once
    sys.exit(0)
os.setsid()
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.close(os.open(os.devnull, os.O_RDONLY))
os.execvp(command[0], command)
