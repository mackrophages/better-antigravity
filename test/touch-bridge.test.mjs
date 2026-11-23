import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_C = path.join(ROOT, 'shared', 'termux-touch-bridge.c')
const IS_LINUX_OR_ANDROID = ['linux', 'android'].includes(process.platform)

function findCompiler () {
  for (const cc of ['gcc', 'cc', 'clang']) {
    const r = spawnSync('sh', ['-c', `command -v ${cc}`], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return cc
  }
  return null
}

const COMPILER = IS_LINUX_OR_ANDROID ? findCompiler() : null

describe('Termux Fullscreen Touch-Scroll PTY Bridge (DECSET 1003 -> 1002)', { skip: !COMPILER }, () => {
  let suiteTmp = ''
  let bin = ''

  before(() => {
    suiteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-touch-suite-'))
    bin = path.join(suiteTmp, 'agy-touch')
    assert.equal(fs.existsSync(SRC_C), true, `Missing C11 source: ${SRC_C}`)
    const res = spawnSync(COMPILER, ['-std=c11', '-O3', '-Wall', '-Wextra', '-Werror', SRC_C, '-o', bin], {
      encoding: 'utf8'
    })
    assert.equal(res.status, 0, `${COMPILER} failed: ${res.stderr || res.stdout}`)
  })

  after(() => {
    if (suiteTmp) fs.rmSync(suiteTmp, { recursive: true, force: true })
  })

  it('bypasses PTY creation on pipes, headless flags/subcommands (even after flags), and refuses self-exec loops', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-touch-bypass-'))
    try {
      // Self-exec guard: pointing AGY_TOUCH_TARGET at bin itself must exit 127 immediately
      const selfRes = spawnSync(bin, [], {
        env: { ...process.env, AGY_TOUCH_TARGET: bin },
        encoding: 'utf8',
        timeout: 3000
      })
      assert.equal(selfRes.status, 127)
      assert.match(selfRes.stderr, /refusing self-exec loop/)

      const mockAgy = path.join(tmp, 'mock-agy.py')
      fs.writeFileSync(mockAgy, [
        '#!/usr/bin/env python3',
        'import json, os, sys',
        'print(json.dumps({',
        '  "argv": sys.argv[1:],',
        '  "isatty": os.isatty(1),',
        '  "touch_tty": os.environ.get("AGY_TOUCH_TTY", "")',
        '}))',
        'sys.exit(42 if "--exit42" in sys.argv else 0)'
      ].join('\n'), { mode: 0o755 })

      // Pipe invocation -> direct execv, exit code 42 preserved
      const cleanPipeEnv = { ...process.env, AGY_TOUCH_TARGET: mockAgy }
      delete cleanPipeEnv.AGY_TOUCH_TTY
      const pipeRes = spawnSync(bin, ['--exit42', 'hello'], {
        env: cleanPipeEnv,
        encoding: 'utf8'
      })
      assert.equal(pipeRes.status, 42)
      const pipeInfo = JSON.parse(pipeRes.stdout.trim())
      assert.deepEqual(pipeInfo.argv, ['--exit42', 'hello'])
      assert.equal(pipeInfo.isatty, false)
      assert.equal(pipeInfo.touch_tty, '')

      // Inside a real outer PTY, `-p`, `plugin list`, and `--model x version` bypass PTY, while `--print=false` wraps
      const ptyCheck = spawnSync('python3', ['-', bin, mockAgy], {
        encoding: 'utf8',
        input: `
import json, os, pty, select, subprocess, sys
bin_path, mock_agy = sys.argv[1], sys.argv[2]

def run_in_pty(args):
    m, s = pty.openpty()
    env = dict(os.environ, AGY_TOUCH_TARGET=mock_agy)
    for k in ('AGY_TOUCH_DISABLE', 'AGY_TOUCH_TTY', 'AGY_HEADLESS', 'BETTER_AGY_SUBCALL', 'CLAUDE_MEM_SIN_HOOK'):
        env.pop(k, None)
    p = subprocess.Popen([bin_path] + args, stdin=s, stdout=s, stderr=s, env=env, close_fds=True)
    os.close(s)
    out = b''
    while True:
        r, _, _ = select.select([m], [], [], 1.0)
        if not r:
            break
        try:
            c = os.read(m, 4096)
            if not c:
                break
            out += c
        except OSError:
            break
    p.wait(timeout=3)
    os.close(m)
    return json.loads(out.decode('utf-8').strip())

for bypass_args in [['-p', 'hola'], ['plugin', 'list'], ['--model', 'gemini-4-hydrogen-high', 'version']]:
    info = run_in_pty(bypass_args)
    assert info['argv'] == bypass_args, info
    assert info['touch_tty'] == '', f"Expected direct execv without bridge PTY for {bypass_args}, got {info}"

wrapped = run_in_pty(['--print=false'])
assert wrapped['touch_tty'] != '', f"Expected --print=false to stay in interactive PTY, got {wrapped}"
print("BYPASS_OK")
`
      })
      assert.equal(ptyCheck.status, 0, ptyCheck.stderr || ptyCheck.stdout)
      assert.match(ptyCheck.stdout, /BYPASS_OK/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('injects DECSET 1002h/1002l across split, reordered ECMA-48, and aborted chunks and preserves 2>err.log', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-touch-stream-'))
    try {
      const errLog = path.join(tmp, 'err.log')
      const mockTui = path.join(tmp, 'mock-tui.py')
      fs.writeFileSync(mockTui, [
        '#!/usr/bin/env python3',
        'import os, sys, time, tty, termios',
        'fd = sys.stdin.fileno()',
        'old = termios.tcgetattr(fd)',
        'tty.setraw(fd)',
        'try:',
        '    sys.stderr.write("DIAG_STDERR_LINE\\n")',
        '    sys.stderr.flush()',
        '    # Aborted \\x1b[?1003; followed by split \\x1b[?1003h and DECRQM \\x1b[?2026$p',
        '    os.write(1, b"\\x1b[?2026$p\\x1b[?1003;\\x1b[?1")',
        '    time.sleep(0.01)',
        '    os.write(1, b"003h")',
        '    # Reordered multi-param ECMA-48 private sequence \\x1b[?1049;1004;1006;1003h split mid-way',
        '    os.write(1, b"\\x1b[?1049;1004;10")',
        '    time.sleep(0.01)',
        '    os.write(1, b"06;1003hREADY")',
        '    got = b""',
        '    while b"M" not in got:',
        '        got += os.read(0, 64)',
        '    os.write(1, b"WHEEL=" + got.replace(b"\\x1b", b"<ESC>") + b"\\x1b[?1006;1003l\\x1b[?1049l")',
        'finally:',
        '    termios.tcsetattr(fd, termios.TCSANOW, old)'
      ].join('\n'), { mode: 0o755 })

      const run = spawnSync('python3', ['-', bin, mockTui, errLog], {
        encoding: 'utf8',
        input: `
import fcntl, os, pty, select, struct, subprocess, sys, time
bin_path, mock_tui, err_path = sys.argv[1], sys.argv[2], sys.argv[3]

m, s = pty.openpty()
fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 90, 0, 0)) if False else None
env = dict(os.environ, AGY_TOUCH_TARGET=mock_tui, TERM='xterm-256color')
for k in ('AGY_TOUCH_DISABLE', 'AGY_TOUCH_TTY', 'AGY_HEADLESS', 'BETTER_AGY_SUBCALL', 'CLAUDE_MEM_SIN_HOOK'):
    env.pop(k, None)

with open(err_path, 'wb') as ef:
    p = subprocess.Popen([bin_path], stdin=s, stdout=s, stderr=ef, env=env, close_fds=True)
os.close(s)

captured = b''
sent_wheel = False
t0 = time.time()
while time.time() - t0 < 5.0:
    r, _, _ = select.select([m], [], [], 0.1)
    if r:
        try:
            c = os.read(m, 8192)
            if not c:
                break
            captured += c
            if (not sent_wheel) and b'READY' in captured:
                os.write(m, b'\\x1b[<64;18;9M')
                sent_wheel = True
        except OSError:
            break

rc = p.wait(timeout=3)
os.close(m)
assert rc == 0, f"rc={rc}"
assert b'\\x1b[?2026$p\\x1b[?1003;\\x1b[?1002h\\x1b[?1003h' in captured, repr(captured)
assert b'\\x1b[?1002h\\x1b[?1049;1004;1006;1003hREADY' in captured, repr(captured)
assert b'WHEEL=<ESC>[<64;18;9M' in captured, repr(captured)
assert b'\\x1b[?1002l\\x1b[?1006;1003l\\x1b[?1049l' in captured, repr(captured)
assert b'DIAG_STDERR_LINE' not in captured, "Redirected stderr leaked onto PTY stdout"
print("STREAM_OK")
`
      })
      assert.equal(run.status, 0, run.stderr || run.stdout)
      assert.match(run.stdout, /STREAM_OK/)
      assert.equal(fs.readFileSync(errLog, 'utf8'), 'DIAG_STDERR_LINE\n')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('handles 32 KB simultaneous bidirectional paste without AB-BA deadlock and exits cleanly even when a grandchild holds slave_fd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-touch-stress-'))
    try {
      const mockHeavy = path.join(tmp, 'mock-heavy.py')
      fs.writeFileSync(mockHeavy, [
        '#!/usr/bin/env python3',
        'import hashlib, os, subprocess, sys, tty, termios',
        'fd = sys.stdin.fileno()',
        'old = termios.tcgetattr(fd)',
        'tty.setraw(fd)',
        '# Spawn an orphaned background grandchild inheriting slave_fd (simulates background hook/daemon)',
        'subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], close_fds=False)',
        'try:',
        '    os.write(1, b"\\x1b[?1049h\\x1b[?1003hSTART_PASTE\\n")',
        '    total_in = bytearray()',
        '    target = 32768',
        '    while len(total_in) < target:',
        '        chunk = os.read(0, 4096)',
        '        if not chunk:',
        '            break',
        '        total_in.extend(chunk)',
        '        # Echo 2x TUI redraw spam concurrently while reading paste to stress both PTY directions',
        '        os.write(1, b"R" * (len(chunk) * 2))',
        '    digest = hashlib.sha256(total_in).hexdigest()[:16]',
        '    os.write(1, f"\\nDIGEST={digest}\\x1b[?1003l\\x1b[?1049l".encode())',
        'finally:',
        '    termios.tcsetattr(fd, termios.TCSANOW, old)'
      ].join('\n'), { mode: 0o755 })

      const run = spawnSync('python3', ['-', bin, mockHeavy], {
        encoding: 'utf8',
        timeout: 10000,
        input: `
import hashlib, os, pty, select, subprocess, sys, time
bin_path, mock_heavy = sys.argv[1], sys.argv[2]

m, s = pty.openpty()
env = dict(os.environ, AGY_TOUCH_TARGET=mock_heavy, TERM='xterm-256color')
for k in ('AGY_TOUCH_DISABLE', 'AGY_TOUCH_TTY', 'AGY_HEADLESS', 'BETTER_AGY_SUBCALL', 'CLAUDE_MEM_SIN_HOOK'):
    env.pop(k, None)

p = subprocess.Popen([bin_path], stdin=s, stdout=s, stderr=s, env=env, close_fds=True)
os.close(s)

payload = (b'0123456789abcdef' * 2048) # 32,768 bytes (> 8x Linux N_TTY_BUF_SIZE 4096)
expected_digest = hashlib.sha256(payload).hexdigest()[:16].encode()

os.set_blocking(m, False)
captured = bytearray()
write_off = 0
started = False
t0 = time.time()

while time.time() - t0 < 6.0:
    want_write = started and write_off < len(payload)
    r, w, _ = select.select([m], [m] if want_write else [], [], 0.05)
    if r:
        try:
            c = os.read(m, 16384)
            if c:
                captured.extend(c)
                if b'START_PASTE' in captured:
                    started = True
        except BlockingIOError:
            pass
        except OSError:
            break
    if w and write_off < len(payload):
        try:
            wn = os.write(m, payload[write_off:write_off + 16384])
            if wn > 0:
                write_off += wn
        except BlockingIOError:
            pass
    if p.poll() is not None:
        # Bridge exited promptly despite background grandchild still sleeping for 30s!
        while True:
            try:
                c2 = os.read(m, 16384)
                if not c2:
                    break
                captured.extend(c2)
            except OSError:
                break
        break

elapsed = time.time() - t0
rc = p.wait(timeout=2)
os.close(m)
assert rc == 0, f"rc={rc}"
assert elapsed < 4.0, f"Expected immediate exit despite grandchild holding slave_fd, took {elapsed:.2f}s"
assert b'DIGEST=' + expected_digest in captured, f"Missing expected SHA-256 digest in tail={bytes(captured[-120:])!r}"
print("STRESS_AND_ORPHAN_OK")
`
      })
      assert.equal(run.status, 0, run.stderr || run.stdout)
      assert.match(run.stdout, /STRESS_AND_ORPHAN_OK/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('propagates SIGWINCH window resizes and restores Termux state if child dies via SIGKILL', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-touch-winch-'))
    try {
      const mockCrashTui = path.join(tmp, 'mock-crash.py')
      fs.writeFileSync(mockCrashTui, [
        '#!/usr/bin/env python3',
        'import fcntl, os, signal, struct, sys, termios, time',
        'resized = []',
        'def on_winch(sig, frame):',
        '    rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\\x00" * 8))',
        '    resized.append((rows, cols))',
        'signal.signal(signal.SIGWINCH, on_winch)',
        'os.write(1, b"\\x1b[?1049h\\x1b[?1003hBOOTED")',
        't0 = time.time()',
        'while not resized and time.time() - t0 < 3.0:',
        '    time.sleep(0.02)',
        'if resized:',
        '    r, c = resized[-1]',
        '    os.write(1, f"SIZE={r}x{c}\\n".encode())',
        'os.kill(os.getpid(), signal.SIGKILL)'
      ].join('\n'), { mode: 0o755 })

      const run = spawnSync('python3', ['-', bin, mockCrashTui], {
        encoding: 'utf8',
        input: `
import fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time
bin_path, mock_crash = sys.argv[1], sys.argv[2]

m, s = pty.openpty()
slave_path = os.ttyname(s)
fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
orig_lflag = termios.tcgetattr(s)[3]
assert (orig_lflag & termios.ECHO) != 0

env = dict(os.environ, AGY_TOUCH_TARGET=mock_crash, TERM='xterm-256color')
for k in ('AGY_TOUCH_DISABLE', 'AGY_TOUCH_TTY', 'AGY_HEADLESS', 'BETTER_AGY_SUBCALL', 'CLAUDE_MEM_SIN_HOOK'):
    env.pop(k, None)

p = subprocess.Popen([bin_path], stdin=s, stdout=s, stderr=s, env=env, close_fds=True)
os.close(s)

captured = b''
sent_resize = False
t0 = time.time()
while time.time() - t0 < 5.0:
    r, _, _ = select.select([m], [], [], 0.1)
    if r:
        try:
            c = os.read(m, 8192)
            if not c:
                break
            captured += c
            if (not sent_resize) and b'BOOTED' in captured:
                fcntl.ioctl(m, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 110, 0, 0))
                os.kill(p.pid, signal.SIGWINCH)
                sent_resize = True
        except OSError:
            break
    if p.poll() is not None:
        while True:
            r2, _, _ = select.select([m], [], [], 0.05)
            if not r2:
                break
            try:
                c2 = os.read(m, 8192)
                if not c2:
                    break
                captured += c2
            except OSError:
                break
        break

rc = p.wait(timeout=3)
after_lflag = termios.tcgetattr(m)[3]
os.close(m)

assert rc == 137, f"Expected exit code 137 (128+SIGKILL), got {rc}"
assert b'SIZE=48x110' in captured, repr(captured)
assert b'\\x1b[?1002l' in captured and b'\\x1b[?1049l' in captured, f"Missing emergency terminal reset in {captured!r}"
assert (after_lflag & termios.ECHO) != 0, "ECHO flag was not restored on outer TTY after child SIGKILL"
print("WINCH_AND_RECOVERY_OK")
`
      })
      assert.equal(run.status, 0, run.stderr || run.stdout)
      assert.match(run.stdout, /WINCH_AND_RECOVERY_OK/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
