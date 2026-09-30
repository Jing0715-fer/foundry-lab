#!/usr/bin/env python3
"""Double-fork daemonizer — launches a command that survives Bash-tool reaping.

Usage: python3 daemon-run.py <cwd> <logfile> <command> [args...]
"""
import os, sys, time

def main():
    cwd, logfile, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]
    pid = os.fork()
    if pid > 0:
        # Parent exits immediately; print daemon pid for the caller.
        print(f"daemon pid: {pid}", flush=True)
        # Small wait so the intermediate fork resolves before the tool call ends.
        time.sleep(0.2)
        sys.exit(0)
    os.setsid()
    pid2 = os.fork()
    if pid2 > 0:
        sys.exit(0)
    # Grandchild: reparented to init, own session, no controlling tty.
    os.chdir(cwd)
    os.umask(0)
    # Redirect stdio to the logfile.
    fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)
    fd0 = os.open(os.devnull, os.O_RDONLY)
    os.dup2(fd0, 0)
    env = dict(os.environ)
    os.execvpe(cmd[0], cmd, env)

if __name__ == "__main__":
    main()
