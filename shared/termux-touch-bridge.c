/*
 * Termux Fullscreen Touch-Scroll PTY Bridge for Google Antigravity CLI (agy).
 *
 * Solves Termux's lack of DECSET 1003 (`\x1b[?1003h`) support in Fullscreen mode
 * (`altScreenMode: "always"`) by injecting `\x1b[?1002h` / `\x1b[?1002l` via a
 * non-blocking, deadlock-free POSIX PTY bridge while bypassing non-TUI invocations.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static int sig_pipe_rd = -1;
static volatile sig_atomic_t sig_pipe_wr = -1;

static void on_signal(int sig) {
  int saved = errno;
  int fd = (int)sig_pipe_wr;
  if (fd >= 0) {
    unsigned char b = (unsigned char)sig;
    if (write(fd, &b, 1) < 0) {
      /* Pipe full: wakeup already queued */
    }
  }
  errno = saved;
}

static bool env_is_one(const char *name) {
  const char *v = getenv(name);
  return v != NULL && strcmp(v, "1") == 0;
}

static bool is_non_tui_subcommand(const char *arg) {
  static const char *const subs[] = {
    "acp", "agent", "agents", "changelog", "help", "install",
    "mcp", "mic-serve", "models", "plugin", "plugins",
    "remote-control", "update", "version"
  };
  for (size_t i = 0; i < sizeof(subs) / sizeof(subs[0]); i++) {
    if (strcmp(arg, subs[i]) == 0) return true;
  }
  return false;
}

static bool flag_takes_value(const char *arg) {
  static const char *const opts[] = {
    "--add-dir", "--agent", "--conversation", "--effort", "-i",
    "--input-format", "--json-schema", "--log-file", "--mode",
    "--model", "--output-format", "--print-timeout", "--project",
    "--prompt-interactive", "--settings"
  };
  for (size_t i = 0; i < sizeof(opts) / sizeof(opts[0]); i++) {
    if (strcmp(arg, opts[i]) == 0) return true;
  }
  return false;
}

static bool is_false_literal(const char *v) {
  return strcmp(v, "false") == 0 || strcmp(v, "0") == 0 || strcmp(v, "no") == 0;
}

static bool should_bypass_pty(int argc, char **argv) {
  if (env_is_one("AGY_TOUCH_DISABLE") ||
      env_is_one("AGY_HEADLESS") ||
      env_is_one("BETTER_AGY_SUBCALL") ||
      env_is_one("CLAUDE_MEM_SIN_HOOK")) {
    return true;
  }
  if (!isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO)) {
    return true;
  }

  /* Prevent nested PTY wrapping on the exact same TTY while allowing new PTYs in daemons */
  const char *active_tty = getenv("AGY_TOUCH_TTY");
  const char *cur_tty = ttyname(STDIN_FILENO);
  if (active_tty != NULL && cur_tty != NULL && strcmp(active_tty, cur_tty) == 0) {
    return true;
  }

  /* Avoid corrupting foreground shell termios if launched in background (`agy &`) */
  pid_t fg = tcgetpgrp(STDIN_FILENO);
  if (fg > 0 && fg != getpgrp()) {
    return true;
  }

  bool seen_positional = false;
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (strcmp(a, "--") == 0) break;
    if (a[0] == '-') {
      if (strcmp(a, "-p") == 0 ||
          strcmp(a, "--print") == 0 ||
          strcmp(a, "--prompt") == 0 ||
          strcmp(a, "-h") == 0 ||
          strcmp(a, "--help") == 0 ||
          strcmp(a, "-v") == 0 ||
          strcmp(a, "--version") == 0) {
        return true;
      }
      if (strncmp(a, "--print=", 8) == 0 && !is_false_literal(a + 8)) {
        return true;
      }
      if (strncmp(a, "--prompt=", 9) == 0 && !is_false_literal(a + 9)) {
        return true;
      }
      if (flag_takes_value(a) && i + 1 < argc) {
        i++;
      }
      continue;
    }
    if (!seen_positional) {
      seen_positional = true;
      if (is_non_tui_subcommand(a)) {
        return true;
      }
    }
  }
  return false;
}

static bool resolve_target_bin(char *out, size_t cap) {
  const char *t = getenv("AGY_TOUCH_TARGET");
  if (t != NULL && t[0] != '\0') {
    int n = snprintf(out, cap, "%s", t);
    return n > 0 && (size_t)n < cap;
  }
  const char *home = getenv("HOME");
  if (home == NULL || home[0] == '\0') home = "/root";
  int n = snprintf(out, cap, "%s/.local/bin/agy", home);
  return n > 0 && (size_t)n < cap;
}

static bool is_same_binary_as_self(const char *target) {
  struct stat st_tgt, st_self;
  if (stat(target, &st_tgt) == 0 && stat("/proc/self/exe", &st_self) == 0) {
    return st_tgt.st_dev == st_self.st_dev && st_tgt.st_ino == st_self.st_ino;
  }
  return false;
}

static bool write_all_stdout(const char *buf, size_t len) {
  size_t off = 0;
  int eagain_retries = 0;
  while (off < len) {
    ssize_t w = write(STDOUT_FILENO, buf + off, len - off);
    if (w > 0) {
      off += (size_t)w;
      eagain_retries = 0;
      continue;
    }
    if (w < 0 && errno == EINTR) continue;
    if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) && eagain_retries < 100) {
      eagain_retries++;
      struct pollfd pfd = {.fd = STDOUT_FILENO, .events = POLLOUT, .revents = 0};
      (void)poll(&pfd, 1, 20);
      continue;
    }
    return false;
  }
  return true;
}

static void sync_winsize(int src_fd, int dst_pty_fd) {
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  if (ioctl(src_fd, TIOCGWINSZ, &ws) == 0 && ws.ws_col > 0 && ws.ws_row > 0) {
    (void)ioctl(dst_pty_fd, TIOCSWINSZ, &ws);
  }
}

static bool is_csi_param_byte(char c) {
  return (c >= '0' && c <= '9') || c == ';';
}

static void parse_csi_priv_codes(const char *p, size_t len, bool *has_1002, bool *has_1003) {
  *has_1002 = false;
  *has_1003 = false;
  unsigned int val = 0;
  bool in_num = false;
  for (size_t k = 0; k <= len; k++) {
    char c = (k < len) ? p[k] : ';';
    if (c >= '0' && c <= '9') {
      if (val < 100000u) val = val * 10u + (unsigned int)(c - '0');
      in_num = true;
    } else if (c == ';') {
      if (in_num) {
        if (val == 1002u) *has_1002 = true;
        if (val == 1003u) *has_1003 = true;
      }
      val = 0;
      in_num = false;
    }
  }
}

enum { MAX_CSI_PARAMS = 48, HOLD_CAP = 52 };

/*
 * Scans `raw_buf[0..total-1]`, injecting `\x1b[?1002h` / `\x1b[?1002l` before any
 * ECMA-48 private mode `CSI ? <params> h/l` sequence that toggles mode 1003,
 * while holding back any incomplete trailing `\x1b[?[0-9;]*` prefix in `hold`.
 */
static bool translate_and_write_chunk(
    const char *raw_buf,
    size_t total,
    char *out_buf,
    size_t out_cap,
    char *hold,
    size_t *hold_len,
    bool *mouse_1002_active) {
  size_t out_len = 0;
  size_t i = 0;

  while (i < total) {
    if (raw_buf[i] == '\x1b') {
      if (i + 1 >= total) {
        break;
      }
      if (raw_buf[i + 1] == '[') {
        if (i + 2 >= total) {
          break;
        }
        if (raw_buf[i + 2] == '?') {
          size_t j = i + 3;
          while (j < total && (j - (i + 3)) < MAX_CSI_PARAMS && is_csi_param_byte(raw_buf[j])) {
            j++;
          }
          if (j >= total && (j - (i + 3)) < MAX_CSI_PARAMS) {
            /* Incomplete `CSI ? <digits;>` at end of buffer: hold for next read */
            break;
          }
          if (j < total && (unsigned char)raw_buf[j] >= 0x40 && (unsigned char)raw_buf[j] <= 0x7e) {
            char final_ch = raw_buf[j];
            size_t seq_len = (j - i) + 1;
            if (final_ch == 'h' || final_ch == 'l') {
              bool has_1002 = false;
              bool has_1003 = false;
              parse_csi_priv_codes(raw_buf + i + 3, j - (i + 3), &has_1002, &has_1003);
              if (final_ch == 'h' && has_1003) {
                if (!has_1002) {
                  memcpy(out_buf + out_len, "\x1b[?1002h", 8);
                  out_len += 8;
                }
                *mouse_1002_active = true;
              } else if (final_ch == 'l' && (has_1003 || has_1002)) {
                if (has_1003 && !has_1002) {
                  memcpy(out_buf + out_len, "\x1b[?1002l", 8);
                  out_len += 8;
                }
                *mouse_1002_active = false;
              }
            }
            if (out_len + seq_len + 32 >= out_cap) {
              if (!write_all_stdout(out_buf, out_len)) return false;
              out_len = 0;
            }
            memcpy(out_buf + out_len, raw_buf + i, seq_len);
            out_len += seq_len;
            i = j + 1;
            continue;
          }
          /* Aborted or intermediate sequence (e.g. `\x1b[?2026$p` or `\x1b[?1003;\x1b`):
             emit `[i .. j-1]` and re-evaluate `raw_buf[j]` on next iteration. */
          size_t prefix_emit = j - i;
          if (out_len + prefix_emit + 32 >= out_cap) {
            if (!write_all_stdout(out_buf, out_len)) return false;
            out_len = 0;
          }
          memcpy(out_buf + out_len, raw_buf + i, prefix_emit);
          out_len += prefix_emit;
          i = j;
          continue;
        }
      }
    }

    out_buf[out_len++] = raw_buf[i++];
    if (out_len + 64 >= out_cap) {
      if (!write_all_stdout(out_buf, out_len)) return false;
      out_len = 0;
    }
  }

  if (i < total) {
    size_t rem = total - i;
    if (rem <= HOLD_CAP) {
      memcpy(hold, raw_buf + i, rem);
      *hold_len = rem;
    } else {
      if (out_len > 0) {
        if (!write_all_stdout(out_buf, out_len)) return false;
        out_len = 0;
      }
      if (!write_all_stdout(raw_buf + i, rem)) return false;
      *hold_len = 0;
    }
  } else {
    *hold_len = 0;
  }

  if (out_len > 0) {
    if (!write_all_stdout(out_buf, out_len)) return false;
  }
  return true;
}

int main(int argc, char **argv) {
  (void)signal(SIGPIPE, SIG_IGN);

  char target[PATH_MAX];
  if (!resolve_target_bin(target, sizeof(target))) {
    fprintf(stderr, "agy-touch: invalid target path\n");
    return 127;
  }
  if (is_same_binary_as_self(target)) {
    fprintf(stderr, "agy-touch: refusing self-exec loop on %s\n", target);
    return 127;
  }

  char **child_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (child_argv == NULL) {
    perror("agy-touch: calloc");
    return 1;
  }
  child_argv[0] = target;
  for (int i = 1; i < argc; i++) {
    child_argv[i] = argv[i];
  }
  child_argv[argc] = NULL;

  if (should_bypass_pty(argc, argv)) {
    execv(target, child_argv);
    perror("agy-touch: execv");
    free(child_argv);
    return 127;
  }

  bool stderr_is_tty = isatty(STDERR_FILENO);
  struct termios orig_termios;
  bool have_termios = (tcgetattr(STDIN_FILENO, &orig_termios) == 0);

  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  if (ioctl(STDIN_FILENO, TIOCGWINSZ, &ws) != 0 || ws.ws_col == 0 || ws.ws_row == 0) {
    ws.ws_row = 24;
    ws.ws_col = 80;
  }

  int master_fd = -1;
  int slave_fd = -1;
  if (openpty(&master_fd, &slave_fd, NULL, have_termios ? &orig_termios : NULL, &ws) != 0) {
    execv(target, child_argv);
    perror("agy-touch: openpty/execv");
    free(child_argv);
    return 127;
  }

  /* Critical: non-blocking master_fd prevents AB-BA deadlock on >4 KB pastes */
  int mflags = fcntl(master_fd, F_GETFL, 0);
  if (mflags >= 0) {
    (void)fcntl(master_fd, F_SETFL, mflags | O_NONBLOCK);
  }

  int sp[2] = {-1, -1};
  if (pipe2(sp, O_NONBLOCK | O_CLOEXEC) != 0) {
    close(master_fd);
    close(slave_fd);
    execv(target, child_argv);
    free(child_argv);
    return 127;
  }
  sig_pipe_rd = sp[0];
  sig_pipe_wr = sp[1];

  static const int tracked_sigs[] = {SIGWINCH, SIGTERM, SIGHUP, SIGINT, SIGCONT, SIGCHLD};
  enum { NUM_SIGS = sizeof(tracked_sigs) / sizeof(tracked_sigs[0]) };
  struct sigaction old_sa[NUM_SIGS];
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  for (size_t i = 0; i < NUM_SIGS; i++) {
    (void)sigaction(tracked_sigs[i], &sa, &old_sa[i]);
  }

  pid_t child_pid = fork();
  if (child_pid < 0) {
    sig_pipe_wr = -1;
    close(sp[0]);
    close(sp[1]);
    close(master_fd);
    close(slave_fd);
    for (size_t i = 0; i < NUM_SIGS; i++) {
      (void)sigaction(tracked_sigs[i], &old_sa[i], NULL);
    }
    execv(target, child_argv);
    free(child_argv);
    return 127;
  }

  if (child_pid == 0) {
    close(master_fd);
    close(sp[0]);
    close(sp[1]);

    for (size_t i = 0; i < NUM_SIGS; i++) {
      (void)sigaction(tracked_sigs[i], &old_sa[i], NULL);
    }
    (void)signal(SIGPIPE, SIG_DFL);

    (void)setsid();
    (void)ioctl(slave_fd, TIOCSCTTY, 0);
    const char *slave_name = ttyname(slave_fd);
    if (slave_name != NULL) {
      (void)setenv("AGY_TOUCH_TTY", slave_name, 1);
    }

    if (dup2(slave_fd, STDIN_FILENO) < 0 ||
        dup2(slave_fd, STDOUT_FILENO) < 0 ||
        (stderr_is_tty && dup2(slave_fd, STDERR_FILENO) < 0)) {
      _exit(127);
    }
    if (slave_fd > STDERR_FILENO) {
      close(slave_fd);
    }
    execv(target, child_argv);
    perror("agy-touch: child execv");
    _exit(127);
  }

  free(child_argv);
  close(slave_fd);

  struct termios raw_termios;
  if (have_termios) {
    raw_termios = orig_termios;
    cfmakeraw(&raw_termios);
    (void)tcsetattr(STDIN_FILENO, TCSANOW, &raw_termios);
  }

  char in_buf[16384];
  size_t in_off = 0;
  size_t in_len = 0;

  char raw_buf[16384 + HOLD_CAP + 16];
  char out_buf[32768 + 128];
  char hold[HOLD_CAP];
  size_t hold_len = 0;

  bool mouse_1002_active = false;
  bool stdin_open = true;
  bool stdout_alive = true;
  bool child_reaped = false;
  int child_status = 0;

  for (;;) {
    /* Always check non-blocking child exit so orphaned slave_fd holders cannot hang exit */
    if (!child_reaped) {
      pid_t wp = waitpid(child_pid, &child_status, WNOHANG);
      if (wp == child_pid && (WIFEXITED(child_status) || WIFSIGNALED(child_status))) {
        child_reaped = true;
      }
    }

    if (child_reaped) {
      /* Drain any immediately buffered output left in master_fd without blocking */
      for (int drain = 0; drain < 64 && stdout_alive; drain++) {
        if (hold_len > 0) {
          memcpy(raw_buf, hold, hold_len);
        }
        ssize_t rn = read(master_fd, raw_buf + hold_len, 16384);
        if (rn > 0) {
          size_t total = hold_len + (size_t)rn;
          hold_len = 0;
          if (!translate_and_write_chunk(raw_buf, total, out_buf, sizeof(out_buf), hold, &hold_len, &mouse_1002_active)) {
            stdout_alive = false;
            break;
          }
        } else {
          break;
        }
      }
      if (hold_len > 0 && stdout_alive) {
        (void)write_all_stdout(hold, hold_len);
        hold_len = 0;
      }
      break;
    }

    struct pollfd pfds[3];
    pfds[0].fd = (stdin_open && in_off == in_len) ? STDIN_FILENO : -1;
    pfds[0].events = POLLIN;
    pfds[0].revents = 0;

    pfds[1].fd = master_fd;
    pfds[1].events = POLLIN | ((in_off < in_len) ? POLLOUT : 0);
    pfds[1].revents = 0;

    pfds[2].fd = sig_pipe_rd;
    pfds[2].events = POLLIN;
    pfds[2].revents = 0;

    /* 80 ms hold timeout tolerates Android/proot ptrace scheduling jitter */
    int timeout_ms = (hold_len > 0) ? 80 : -1;
    int pr = poll(pfds, 3, timeout_ms);
    if (pr < 0) {
      if (errno == EINTR) continue;
      break;
    }

    if (pr == 0 && hold_len > 0) {
      if (!write_all_stdout(hold, hold_len)) {
        stdout_alive = false;
        (void)kill(-child_pid, SIGHUP);
        break;
      }
      hold_len = 0;
      continue;
    }

    if (pfds[2].revents & POLLIN) {
      unsigned char sigs[64];
      ssize_t sn = read(sig_pipe_rd, sigs, sizeof(sigs));
      for (ssize_t i = 0; i < sn; i++) {
        int sig = (int)sigs[i];
        if (sig == SIGWINCH) {
          sync_winsize(STDIN_FILENO, master_fd);
        } else if (sig == SIGCONT) {
          if (have_termios) {
            (void)tcsetattr(STDIN_FILENO, TCSANOW, &raw_termios);
          }
          sync_winsize(STDIN_FILENO, master_fd);
          (void)kill(-child_pid, SIGCONT);
          if (mouse_1002_active && stdout_alive) {
            (void)write_all_stdout("\x1b[?1002h", 8);
          }
        } else if (sig == SIGTERM || sig == SIGHUP) {
          (void)kill(-child_pid, sig);
          (void)kill(child_pid, sig);
        } else if (sig == SIGINT) {
          (void)kill(child_pid, SIGINT);
        } else if (sig == SIGCHLD && !child_reaped) {
          pid_t wp = waitpid(child_pid, &child_status, WNOHANG);
          if (wp == child_pid && (WIFEXITED(child_status) || WIFSIGNALED(child_status))) {
            child_reaped = true;
          }
        }
      }
    }

    /* Drain master_fd -> STDOUT first so child output never blocks on full PTY buffer */
    if (pfds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      if (hold_len > 0) {
        memcpy(raw_buf, hold, hold_len);
      }
      ssize_t rn = read(master_fd, raw_buf + hold_len, 16384);
      if (rn > 0) {
        size_t total = hold_len + (size_t)rn;
        hold_len = 0;
        if (!translate_and_write_chunk(raw_buf, total, out_buf, sizeof(out_buf), hold, &hold_len, &mouse_1002_active)) {
          stdout_alive = false;
          (void)kill(-child_pid, SIGHUP);
          break;
        }
      } else if (rn == 0 || (rn < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) {
        if (hold_len > 0 && stdout_alive) {
          (void)write_all_stdout(hold, hold_len);
          hold_len = 0;
        }
        break;
      }
    }

    /* Flush any pending STDIN -> master_fd bytes non-blockingly */
    if (in_off < in_len && (pfds[1].revents & POLLOUT)) {
      ssize_t wn = write(master_fd, in_buf + in_off, in_len - in_off);
      if (wn > 0) {
        in_off += (size_t)wn;
        if (in_off == in_len) {
          in_off = 0;
          in_len = 0;
        }
      } else if (wn < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
        stdin_open = false;
        in_off = 0;
        in_len = 0;
      }
    }

    /* Read fresh STDIN bytes when pending input buffer is empty */
    if (stdin_open && in_off == in_len && (pfds[0].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t rn = read(STDIN_FILENO, in_buf, sizeof(in_buf));
      if (rn > 0) {
        ssize_t wn = write(master_fd, in_buf, (size_t)rn);
        if (wn > 0 && (size_t)wn == (size_t)rn) {
          in_off = 0;
          in_len = 0;
        } else if (wn >= 0) {
          in_off = (size_t)wn;
          in_len = (size_t)rn;
        } else if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) {
          in_off = 0;
          in_len = (size_t)rn;
        } else {
          stdin_open = false;
        }
      } else if (rn == 0 || (rn < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) {
        stdin_open = false;
      }
    }
  }

  int wr_fd = (int)sig_pipe_wr;
  sig_pipe_wr = -1;
  close(master_fd);
  if (sig_pipe_rd >= 0) close(sig_pipe_rd);
  if (wr_fd >= 0) close(wr_fd);

  if (!child_reaped) {
    while (waitpid(child_pid, &child_status, 0) < 0) {
      if (errno != EINTR) break;
    }
  }

  if (mouse_1002_active && stdout_alive) {
    static const char reset_seq[] = "\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l";
    (void)write_all_stdout(reset_seq, sizeof(reset_seq) - 1);
  }

  if (have_termios) {
    (void)tcsetattr(STDIN_FILENO, TCSANOW, &orig_termios);
  }

  if (WIFEXITED(child_status)) {
    return WEXITSTATUS(child_status);
  }
  if (WIFSIGNALED(child_status)) {
    return 128 + WTERMSIG(child_status);
  }
  return 1;
}
