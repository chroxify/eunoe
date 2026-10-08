#!/usr/bin/env python3
# Drives an interactive claude session through a logging eunoe proxy:
# message, /compact, message. Then prints the system-prompt hash per request
# so a prompt switch after compaction shows up. Costs a few thousand tokens.
import json, os, pty, re, select, subprocess, sys, tempfile, time

config_dir = sys.argv[1]
port = 8898
eunoe_dir = tempfile.mkdtemp(prefix="eunoe-probe-")
with open(os.path.join(eunoe_dir, "config.json"), "w") as f:
    json.dump({"port": port, "mode": "off", "window": 200000, "eval": {"trustHeaders": True}}, f)
logfile = os.path.join(eunoe_dir, "dump.jsonl")
proxy = subprocess.Popen(["bun", os.path.join(os.path.dirname(__file__), "dump-proxy.ts"), str(port), logfile], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
cwd = tempfile.mkdtemp(prefix="probe-cwd-")
env = {**os.environ, "CLAUDE_CONFIG_DIR": config_dir, "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}", "TERM": "xterm-256color"}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe("claude", ["claude", "--model", "claude-haiku-4-5-20251001", "--settings", json.dumps({"disableAllHooks": True, "env": {"ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}"}})], env)

def drain(seconds):
    end = time.time() + seconds
    out = b""
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try: out += os.read(fd, 65536)
            except OSError: break
    return out.decode(errors="replace")

def send(text, wait):
    os.write(fd, text.encode())
    time.sleep(0.3)
    os.write(fd, b"\r")
    return drain(wait)

first = drain(10)
if re.search(r"trust|Yes, proceed|Enter to confirm", first, re.I):
    os.write(fd, b"\x1b[B"); time.sleep(0.4); os.write(fd, b"\r"); first += drain(8)
print("BOOT:", re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", first)[-600:], file=sys.stderr)
out = send("Reply with exactly one word: ready", 25)
print("T1:", re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out)[-300:], file=sys.stderr)
out = send("/compact", 90)
print("COMPACT:", re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out)[-300:], file=sys.stderr)
send("Reply with exactly one word: again", 25)
os.write(fd, b"\x03"); time.sleep(0.5); os.write(fd, b"\x03"); time.sleep(1)
try: os.kill(pid, 9)
except Exception: pass
proxy.kill()
proxy.wait(timeout=5) if False else None
for line in open(logfile):
    print(line.strip())
