/*
 * Native C11 zero-dependency accelerator for Better Antigravity statusLine (~6ms in proot, <1ms native).
 * Full byte-for-byte parity with `shared/better-statusline.mjs`:
 * - Per-model dynamic context window identifier (`✦ context 18%/1M`, `✻ context 58%/200k`, `❂ context 42%/128k`)
 *   and race-free per-model / per-session window cache (`context-windows/model-<id>.json`, `sess-<sid>.json`)
 * - JSON `\uXXXX` + UTF-16 surrogate pair UTF-8 decoding
 * - Portable ISO-8601 `reset_time` parsing (civil-from-days UTC arithmetic)
 * - Control/escape sequence stripping (`sanitize_inline_utf8`)
 * - 8 MB state ceiling + top-level `maxId` support for Time Machine
 * - Unified wcwidth column counter, 0600 atomic cache writes, dynamic plugin directory sizing,
 *   clamped float-to-int casts, and `/proc/<pid>/cmdline` Narrator worker verification.
 */
#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define R "\x1b[0m"
#define DIM "\x1b[2m"
#define BOLD "\x1b[1m"
#define GREEN "\x1b[32m"
#define YELLOW "\x1b[33m"
#define RED "\x1b[91m"
#define BLUE "\x1b[94m"
#define CYAN "\x1b[36m"
#define MAGENTA "\x1b[95m"
#define AGY_BLUE "\x1b[38;5;75m"
#define AGY_SKY "\x1b[38;5;39m"
#define CLAUDE_AMBER "\x1b[38;5;208m"
#define GPT_SILVER "\x1b[38;5;252m"
#define GPT_SLATE "\x1b[38;5;247m"
#define SEP "\x1b[2m · \x1b[0m"

#define STATE_MAX_BYTES (8u * 1024u * 1024u)

enum { KIND_GOOGLE = 0, KIND_CLAUDE = 1, KIND_GPT = 2 };

typedef struct {
  char full[768];
  char compact[512];
  char minimal[384];
} Widget;

static int clamp_double_to_int(double v, int lo, int hi) {
  if (!isfinite(v)) return lo;
  if (v <= (double)lo) return lo;
  if (v >= (double)hi) return hi;
  return (int)v;
}

static uint32_t rol32(uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }

static void sha1_hex12(const char *msg, char out[13]) {
  size_t len = strlen(msg);
  uint64_t bit_len = (uint64_t)len * 8ULL;
  size_t pad_len = ((len + 8) / 64 + 1) * 64;
  uint8_t *buf = (uint8_t *)calloc(pad_len, 1);
  if (!buf) { strcpy(out, "000000000000"); return; }
  memcpy(buf, msg, len);
  buf[len] = 0x80;
  for (int i = 0; i < 8; i++) buf[pad_len - 1 - i] = (uint8_t)((bit_len >> (i * 8)) & 0xffULL);

  uint32_t h0 = 0x67452301u, h1 = 0xEFCDAB89u, h2 = 0x98BADCFEu, h3 = 0x10325476u, h4 = 0xC3D2E1F0u;
  for (size_t chunk = 0; chunk < pad_len; chunk += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++) {
      size_t o = chunk + (size_t)i * 4;
      w[i] = ((uint32_t)buf[o] << 24) | ((uint32_t)buf[o + 1] << 16) | ((uint32_t)buf[o + 2] << 8) | buf[o + 3];
    }
    for (int i = 16; i < 80; i++) w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999u; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1u; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDCu; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6u; }
      uint32_t temp = rol32(a, 5) + f + e + k + w[i];
      e = d; d = c; c = rol32(b, 30); b = a; a = temp;
    }
    h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
  }
  free(buf);
  char full[41];
  snprintf(full, sizeof(full), "%08x%08x%08x%08x%08x", h0, h1, h2, h3, h4);
  memcpy(out, full, 12);
  out[12] = '\0';
}

static void mkdir_p_private(const char *dir) {
  char tmp[PATH_MAX];
  size_t len = strlen(dir);
  if (len == 0 || len >= sizeof(tmp)) return;
  memcpy(tmp, dir, len + 1);
  for (char *p = tmp + 1; *p; p++) {
    if (*p == '/') {
      *p = '\0';
      (void)mkdir(tmp, 0700);
      *p = '/';
    }
  }
  (void)mkdir(tmp, 0700);
}

static void expand_tilde(const char *in, const char *home, char *out, size_t cap) {
  if (!in || !*in) { out[0] = '\0'; return; }
  if (strcmp(in, "~") == 0) { snprintf(out, cap, "%s", home); return; }
  if (in[0] == '~' && in[1] == '/') { snprintf(out, cap, "%s%s", home, in + 1); return; }
  snprintf(out, cap, "%s", in);
}

static void sanitize_sid(const char *raw, char *out, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; raw[i] && o + 1 < cap && o < 64; i++) {
    unsigned char c = (unsigned char)raw[i];
    if (isalnum(c) || c == '_' || c == '-') out[o++] = (char)c;
  }
  out[o] = '\0';
}

static void sanitize_model_key(const char *raw, char *out, size_t cap) {
  size_t o = 0;
  bool prev_dash = true;
  for (size_t i = 0; raw[i] && o + 1 < cap && o < 64; i++) {
    unsigned char c = (unsigned char)tolower((unsigned char)raw[i]);
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-') {
      out[o++] = (char)c;
      prev_dash = (c == '-');
    } else if (!prev_dash) {
      out[o++] = '-';
      prev_dash = true;
    }
  }
  while (o > 0 && out[o - 1] == '-') o--;
  out[o] = '\0';
}

/* Decode one UTF-8 codepoint from `s[*idx]`; returns replacement 0xFFFD on malformed byte. */
static uint32_t next_utf8_cp(const char *s, size_t *idx) {
  unsigned char b0 = (unsigned char)s[*idx];
  if (b0 == 0) return 0;
  if (b0 < 0x80) {
    (*idx)++;
    return b0;
  }
  if ((b0 & 0xe0) == 0xc0) {
    unsigned char b1 = (unsigned char)s[*idx + 1];
    if ((b1 & 0xc0) == 0x80) {
      uint32_t cp = ((uint32_t)(b0 & 0x1f) << 6) | (uint32_t)(b1 & 0x3f);
      if (cp >= 0x80) {
        *idx += 2;
        return cp;
      }
    }
    (*idx)++;
    return 0xfffdu;
  }
  if ((b0 & 0xf0) == 0xe0) {
    unsigned char b1 = (unsigned char)s[*idx + 1];
    unsigned char b2 = (unsigned char)s[*idx + 2];
    if ((b1 & 0xc0) == 0x80 && (b2 & 0xc0) == 0x80) {
      uint32_t cp = ((uint32_t)(b0 & 0x0f) << 12) | ((uint32_t)(b1 & 0x3f) << 6) | (uint32_t)(b2 & 0x3f);
      if (cp >= 0x800 && !(cp >= 0xd800 && cp <= 0xdfff)) {
        *idx += 3;
        return cp;
      }
    }
    (*idx)++;
    return 0xfffdu;
  }
  if ((b0 & 0xf8) == 0xf0) {
    unsigned char b1 = (unsigned char)s[*idx + 1];
    unsigned char b2 = (unsigned char)s[*idx + 2];
    unsigned char b3 = (unsigned char)s[*idx + 3];
    if ((b1 & 0xc0) == 0x80 && (b2 & 0xc0) == 0x80 && (b3 & 0xc0) == 0x80) {
      uint32_t cp = ((uint32_t)(b0 & 0x07) << 18) | ((uint32_t)(b1 & 0x3f) << 12) |
                    ((uint32_t)(b2 & 0x3f) << 6) | (uint32_t)(b3 & 0x3f);
      if (cp >= 0x10000 && cp <= 0x10ffff) {
        *idx += 4;
        return cp;
      }
    }
    (*idx)++;
    return 0xfffdu;
  }
  (*idx)++;
  return 0xfffdu;
}

static size_t encode_utf8_cp(uint32_t cp, char *out, size_t rem) {
  if (cp <= 0x7fu) {
    if (rem < 2) return 0;
    out[0] = (char)cp;
    return 1;
  }
  if (cp <= 0x7ffu) {
    if (rem < 3) return 0;
    out[0] = (char)(0xc0u | (cp >> 6));
    out[1] = (char)(0x80u | (cp & 0x3fu));
    return 2;
  }
  if (cp >= 0xd800u && cp <= 0xdfffu) cp = 0xfffdu;
  if (cp <= 0xffffu) {
    if (rem < 4) return 0;
    out[0] = (char)(0xe0u | (cp >> 12));
    out[1] = (char)(0x80u | ((cp >> 6) & 0x3fu));
    out[2] = (char)(0x80u | (cp & 0x3fu));
    return 3;
  }
  if (cp <= 0x10ffffu) {
    if (rem < 5) return 0;
    out[0] = (char)(0xf0u | (cp >> 18));
    out[1] = (char)(0x80u | ((cp >> 12) & 0x3fu));
    out[2] = (char)(0x80u | ((cp >> 6) & 0x3fu));
    out[3] = (char)(0x80u | (cp & 0x3fu));
    return 4;
  }
  return 0;
}

static void sanitize_inline_utf8(const char *in, char *out, size_t cap, int max_codepoints) {
  if (cap == 0) return;
  size_t idx = 0, o = 0;
  int count = 0;
  while (in[idx] != '\0' && o + 1 < cap) {
    if (max_codepoints > 0 && count >= max_codepoints) break;
    uint32_t cp = next_utf8_cp(in, &idx);
    if (cp == '\r' || cp == '\n' || cp == '\t') {
      out[o++] = ' ';
      count++;
      continue;
    }
    if (cp < 0x20u || (cp >= 0x7fu && cp <= 0x9fu)) {
      continue;
    }
    size_t n = encode_utf8_cp(cp, out + o, cap - o);
    if (n == 0) break;
    o += n;
    count++;
  }
  out[o] = '\0';
}

static void fprint_json_str(FILE *f, const char *s) {
  fputc('"', f);
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { fputc('\\', f); fputc(c, f); }
    else if (c == '\n') fputs("\\n", f);
    else if (c == '\r') fputs("\\r", f);
    else if (c == '\t') fputs("\\t", f);
    else if (c >= 0x20) fputc(c, f);
  }
  fputc('"', f);
}

static char *read_file_str(const char *path, size_t max_bytes) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
  long sz = ftell(f);
  if (sz < 0) { fclose(f); return NULL; }
  size_t n = (size_t)sz > max_bytes ? max_bytes : (size_t)sz;
  rewind(f);
  char *buf = (char *)malloc(n + 1);
  if (!buf) { fclose(f); return NULL; }
  size_t r = fread(buf, 1, n, f);
  buf[r] = '\0';
  fclose(f);
  return buf;
}

static char *read_stdin_all(void) {
  if (isatty(STDIN_FILENO)) return NULL;
  size_t cap = 8192, len = 0;
  char *buf = (char *)malloc(cap);
  if (!buf) return NULL;
  while (1) {
    if (len + 4096 >= cap) {
      cap *= 2;
      if (cap > 2097152) break;
      char *nb = (char *)realloc(buf, cap);
      if (!nb) break;
      buf = nb;
    }
    ssize_t r = read(STDIN_FILENO, buf + len, 4096);
    if (r <= 0) break;
    len += (size_t)r;
  }
  buf[len] = '\0';
  return buf;
}

static const char *skip_ws(const char *p, const char *end) {
  while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
  return p;
}

static const char *skip_json_string(const char *p, const char *end) {
  if (p >= end || *p != '"') return p;
  p++;
  while (p < end) {
    if (*p == '\\') {
      p += (p + 1 < end) ? 2 : 1;
      continue;
    }
    if (*p == '"') return p + 1;
    p++;
  }
  return end;
}

static const char *skip_json_value(const char *p, const char *end) {
  p = skip_ws(p, end);
  if (p >= end) return end;
  if (*p == '"') return skip_json_string(p, end);
  if (*p == '{' || *p == '[') {
    char open = *p, close = (*p == '{') ? '}' : ']';
    int depth = 1;
    p++;
    while (p < end && depth > 0) {
      if (*p == '"') { p = skip_json_string(p, end); continue; }
      if (*p == open) depth++;
      else if (*p == close) depth--;
      p++;
    }
    return p;
  }
  while (p < end && *p != ',' && *p != '}' && *p != ']' && !isspace((unsigned char)*p)) p++;
  return p;
}

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

static bool parse_hex4(const char *p, const char *end, uint32_t *out) {
  if (p + 4 > end) return false;
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) {
    int h = hex_val(p[i]);
    if (h < 0) return false;
    v = (v << 4) | (uint32_t)h;
  }
  *out = v;
  return true;
}

static bool json_read_str(const char *val, const char *end, char *out, size_t cap) {
  if (!val || val >= end || *val != '"' || cap == 0) return false;
  const char *p = val + 1;
  size_t o = 0;
  while (p < end && *p != '"' && o + 1 < cap) {
    if (*p == '\\' && p + 1 < end) {
      p++;
      char c = *p++;
      if (c == 'n') out[o++] = '\n';
      else if (c == 'r') out[o++] = '\r';
      else if (c == 't') out[o++] = '\t';
      else if (c == 'b') out[o++] = '\b';
      else if (c == 'f') out[o++] = '\f';
      else if (c == '"' || c == '\\' || c == '/') out[o++] = c;
      else if (c == 'u') {
        uint32_t u1 = 0;
        if (!parse_hex4(p, end, &u1)) continue;
        p += 4;
        uint32_t cp = u1;
        if (u1 >= 0xd800u && u1 <= 0xdbffu) {
          uint32_t u2 = 0;
          if (p + 6 <= end && p[0] == '\\' && p[1] == 'u' && parse_hex4(p + 2, end, &u2) &&
              u2 >= 0xdc00u && u2 <= 0xdfffu) {
            p += 6;
            cp = 0x10000u + (((u1 - 0xd800u) << 10) | (u2 - 0xdc00u));
          } else {
            cp = 0xfffdu;
          }
        } else if (u1 >= 0xdc00u && u1 <= 0xdfffu) {
          cp = 0xfffdu;
        }
        if (cp == 0) continue;
        size_t n = encode_utf8_cp(cp, out + o, cap - o);
        if (n == 0) break;
        o += n;
      } else {
        if (c != '\0') out[o++] = c;
      }
    } else {
      char raw_c = *p++;
      if (raw_c != '\0') out[o++] = raw_c;
    }
  }
  out[o] = '\0';
  return true;
}

static const char *json_get_prop(const char *obj_start, const char *obj_end, const char *key) {
  if (!obj_start || !obj_end || obj_start >= obj_end) return NULL;
  const char *p = skip_ws(obj_start, obj_end);
  if (p >= obj_end || *p != '{') return NULL;
  p++;
  size_t klen = strlen(key);
  const char *found = NULL;
  while (p < obj_end) {
    p = skip_ws(p, obj_end);
    if (p >= obj_end || *p == '}') break;
    if (*p == ',') { p++; continue; }
    if (*p != '"') break;
    const char *ks = p + 1;
    const char *ke = skip_json_string(p, obj_end);
    size_t slen = (ke > ks) ? (size_t)(ke - 1 - ks) : 0;
    bool match = false;
    if (slen == klen && memcmp(ks, key, klen) == 0) {
      match = true;
    } else if (memchr(ks, '\\', slen) != NULL) {
      char decoded_key[128];
      if (json_read_str(p, ke, decoded_key, sizeof(decoded_key)) && strcmp(decoded_key, key) == 0) {
        match = true;
      }
    }
    p = skip_ws(ke, obj_end);
    if (p >= obj_end || *p != ':') break;
    p = skip_ws(p + 1, obj_end);
    if (match) found = p;
    p = skip_json_value(p, obj_end);
  }
  return found;
}

static bool json_obj_bounds(const char *val, const char *end, const char **out_s, const char **out_e) {
  if (!val || val >= end || *val != '{') return false;
  *out_s = val;
  *out_e = skip_json_value(val, end);
  return true;
}

static bool json_read_num(const char *val, const char *end, double *out) {
  if (!val || val >= end) return false;
  if (*val != '-' && !isdigit((unsigned char)*val)) return false;
  char *ep = NULL;
  double v = strtod(val, &ep);
  if (ep == val) return false;
  *out = v;
  return true;
}

static int json_read_bool(const char *val, const char *end) {
  if (!val || val >= end) return -1;
  if (end - val >= 4 && memcmp(val, "true", 4) == 0) return 1;
  if (end - val >= 5 && memcmp(val, "false", 5) == 0) return 0;
  return -1;
}

static long long days_from_civil(int y, unsigned m, unsigned d) {
  y -= (m <= 2);
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153u * (m + (m > 2 ? (unsigned)-3 : 9u)) + 2u) / 5u + d - 1u;
  const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
  return (long long)era * 146097LL + (long long)doe - 719468LL;
}

static bool parse_digits(const char **p, int n, int *out) {
  int v = 0;
  for (int i = 0; i < n; i++) {
    unsigned char c = (unsigned char)(*p)[i];
    if (!isdigit(c)) return false;
    v = v * 10 + (c - '0');
  }
  *p += n;
  *out = v;
  return true;
}

static bool parse_iso8601_ms(const char *s, long long *out_ms) {
  if (!s || !*s) return false;
  const char *p = s;
  while (*p == ' ') p++;
  int year = 0, mon = 0, day = 0, hour = 0, min = 0, sec = 0;
  if (!parse_digits(&p, 4, &year) || *p++ != '-') return false;
  if (!parse_digits(&p, 2, &mon) || *p++ != '-') return false;
  if (!parse_digits(&p, 2, &day)) return false;
  if (*p != 'T' && *p != 't' && *p != ' ') return false;
  p++;
  if (!parse_digits(&p, 2, &hour) || *p++ != ':') return false;
  if (!parse_digits(&p, 2, &min) || *p++ != ':') return false;
  if (!parse_digits(&p, 2, &sec)) return false;
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 60) return false;

  int ms = 0;
  if (*p == '.') {
    p++;
    if (!isdigit((unsigned char)*p)) return false;
    int scale = 100;
    while (isdigit((unsigned char)*p)) {
      if (scale >= 1) {
        ms += (*p - '0') * scale;
        scale /= 10;
      }
      p++;
    }
  }

  int tz_min = 0;
  if (*p == 'Z' || *p == 'z') {
    p++;
  } else if (*p == '+' || *p == '-') {
    int sign = (*p == '+') ? 1 : -1;
    p++;
    int tzh = 0, tzm = 0;
    if (!parse_digits(&p, 2, &tzh)) return false;
    if (*p == ':') p++;
    if (isdigit((unsigned char)p[0]) && isdigit((unsigned char)p[1])) {
      if (!parse_digits(&p, 2, &tzm)) return false;
    }
    if (tzh > 23 || tzm > 59) return false;
    tz_min = sign * (tzh * 60 + tzm);
  } else {
    return false;
  }
  while (*p == ' ') p++;
  if (*p != '\0') return false;

  long long days = days_from_civil(year, (unsigned)mon, (unsigned)day);
  long long total_sec = days * 86400LL + (long long)hour * 3600LL + (long long)min * 60LL + (long long)sec - (long long)tz_min * 60LL;
  *out_ms = total_sec * 1000LL + (long long)ms;
  return true;
}

static bool write_atomic_file_0600(const char *target_path, const char *content) {
  char tmpp[PATH_MAX + 64];
  snprintf(tmpp, sizeof(tmpp), "%s.tmp-%d", target_path, (int)getpid());
  int fd = open(tmpp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return false;
  FILE *f = fdopen(fd, "wb");
  if (!f) {
    close(fd);
    unlink(tmpp);
    return false;
  }
  size_t len = strlen(content);
  bool ok = (fwrite(content, 1, len, f) == len) && (fflush(f) == 0);
  if (fclose(f) != 0) ok = false;
  if (!ok) {
    unlink(tmpp);
    return false;
  }
  if (rename(tmpp, target_path) != 0) {
    unlink(tmpp);
    return false;
  }
  return true;
}

static void short_tokens(double raw_n, char out[32]) {
  long long val = isfinite(raw_n) && raw_n > 0 ? (long long)floor(raw_n + 0.5) : 0;
  if (val < 1000) {
    snprintf(out, 32, "%lld", val);
    return;
  }
  const char *units[] = {"k", "M", "B"};
  int unit = 0;
  double scale = 100.0;
  long long tenths = (long long)floor((double)val / scale + 0.5);
  while (tenths >= 10000 && unit < 2) {
    unit++;
    scale *= 1000.0;
    tenths = (long long)floor((double)val / scale + 0.5);
  }
  snprintf(out, 32, "%lld.%lld%s", tenths / 10, tenths % 10, units[unit]);
}

static void short_window_label(long long raw_win, char out[24]) {
  long long n = raw_win > 0 ? raw_win : 200000LL;
  if (n >= 950000LL) {
    double bm = (double)n / 1048576.0;
    long long rbm = (long long)llround(bm);
    if (fabs(bm - (double)rbm) < 0.02 && rbm >= 1) {
      snprintf(out, 24, "%lldM", rbm);
      return;
    }
    long long tenths = (long long)llround((double)n / 100000.0);
    if (tenths % 10 == 0) snprintf(out, 24, "%lldM", tenths / 10);
    else snprintf(out, 24, "%lld.%lldM", tenths / 10, tenths % 10);
    return;
  }
  if (n >= 1024LL && (n & (n - 1LL)) == 0) {
    snprintf(out, 24, "%lldk", n / 1024LL);
    return;
  }
  long long k = (long long)llround((double)n / 1000.0);
  if (k < 1) k = 1;
  snprintf(out, 24, "%lldk", k);
}

static void format_until(double sec, char out[32]) {
  if (!isfinite(sec) || sec <= 0) { out[0] = '\0'; return; }
  long long minutes = (long long)floor(sec / 60.0 + 0.5);
  if (minutes < 1) minutes = 1;
  if (minutes < 60) { snprintf(out, 32, "%lldm", minutes); return; }
  long long hours = minutes / 60;
  if (hours < 24) { snprintf(out, 32, "%lldh %lldm", hours, minutes % 60); return; }
  snprintf(out, 32, "%lldd %lldh", hours / 24, hours % 24);
}

static bool is_zero_width_cp(uint32_t cp) {
  return cp < 0x20u ||
         (cp >= 0x7fu && cp < 0xa0u) ||
         (cp >= 0x0300u && cp <= 0x036fu) ||
         (cp >= 0x1ab0u && cp <= 0x1affu) ||
         (cp >= 0x1dc0u && cp <= 0x1dffu) ||
         (cp >= 0x200bu && cp <= 0x200fu) ||
         (cp >= 0x20d0u && cp <= 0x20ffu) ||
         (cp >= 0xfe00u && cp <= 0xfe0fu) ||
         (cp >= 0xfe20u && cp <= 0xfe2fu);
}

static bool is_wide_cp(uint32_t cp) {
  return (cp >= 0x1100u && cp <= 0x115fu) ||
         (cp >= 0x231au && cp <= 0x231bu) ||
         (cp >= 0x2329u && cp <= 0x232au) ||
         (cp >= 0x23e9u && cp <= 0x23f3u) ||
         (cp >= 0x23f8u && cp <= 0x23fau) ||
         (cp >= 0x25fdu && cp <= 0x25feu) ||
         (cp >= 0x2614u && cp <= 0x2615u) ||
         (cp >= 0x2648u && cp <= 0x2653u) ||
         cp == 0x267fu || cp == 0x2693u || cp == 0x26a1u ||
         (cp >= 0x26aau && cp <= 0x26abu) ||
         (cp >= 0x26bdu && cp <= 0x26beu) ||
         (cp >= 0x26c4u && cp <= 0x26c5u) ||
         cp == 0x26ceu || cp == 0x26d4u || cp == 0x26eau ||
         (cp >= 0x26f2u && cp <= 0x26f3u) ||
         cp == 0x26f5u || cp == 0x26fau || cp == 0x26fdu ||
         cp == 0x2705u ||
         (cp >= 0x270au && cp <= 0x270bu) ||
         cp == 0x2728u || cp == 0x274cu || cp == 0x274eu ||
         (cp >= 0x2753u && cp <= 0x2755u) ||
         cp == 0x2757u ||
         (cp >= 0x2795u && cp <= 0x2797u) ||
         cp == 0x27b0u || cp == 0x27bfu ||
         (cp >= 0x2b1bu && cp <= 0x2b1cu) ||
         cp == 0x2b50u || cp == 0x2b55u ||
         (cp >= 0x2e80u && cp <= 0x303eu) ||
         (cp >= 0x3040u && cp <= 0x33bfu) ||
         (cp >= 0x3400u && cp <= 0x4dbfu) ||
         (cp >= 0x4e00u && cp <= 0xa4cfu) ||
         (cp >= 0xa960u && cp <= 0xa97cu) ||
         (cp >= 0xac00u && cp <= 0xd7a3u) ||
         (cp >= 0xf900u && cp <= 0xfaffu) ||
         (cp >= 0xfe10u && cp <= 0xfe19u) ||
         (cp >= 0xfe30u && cp <= 0xfe6fu) ||
         (cp >= 0xff01u && cp <= 0xff60u) ||
         (cp >= 0xffe0u && cp <= 0xffe6u) ||
         (cp >= 0x1f000u && cp <= 0x1faffu) ||
         (cp >= 0x20000u && cp <= 0x3fffdu);
}

static int visible_width(const char *s) {
  int w = 0;
  for (size_t i = 0; s[i] != '\0';) {
    unsigned char c = (unsigned char)s[i];
    if (c == 0x1b) {
      unsigned char n = (unsigned char)s[i + 1];
      if (n == '[') {
        i += 2;
        while (s[i] != '\0') {
          unsigned char m = (unsigned char)s[i++];
          if (m >= 0x40 && m <= 0x7e) break;
        }
        continue;
      }
      if (n == ']') {
        i += 2;
        while (s[i] != '\0') {
          unsigned char m = (unsigned char)s[i++];
          if (m == 0x07) break;
          if (m == 0x1b && s[i] == '\\') { i++; break; }
        }
        continue;
      }
    }
    uint32_t cp = next_utf8_cp(s, &i);
    if (is_zero_width_cp(cp)) continue;
    size_t peek = i;
    uint32_t next_cp = s[peek] ? next_utf8_cp(s, &peek) : 0;
    if (next_cp == 0xfe0eu) {
      w += 1;
      i = peek;
      continue;
    }
    if (next_cp == 0xfe0fu) {
      w += 2;
      i = peek;
      continue;
    }
    w += is_wide_cp(cp) ? 2 : 1;
  }
  return w;
}

static bool contains_icase(const char *hay, const char *needle) {
  size_t nlen = strlen(needle);
  for (const char *p = hay; *p; p++) {
    size_t i = 0;
    while (i < nlen && p[i] && tolower((unsigned char)p[i]) == tolower((unsigned char)needle[i])) i++;
    if (i == nlen) return true;
  }
  return false;
}

static const char *static_family_icon(int kind) {
  return (kind == KIND_CLAUDE) ? "\xe2\x9c\xbb" : ((kind == KIND_GPT) ? "\xe2\x9d\x82" : "\xe2\x9c\xa6");
}

static const char *family_icon_color(int kind) {
  return (kind == KIND_CLAUDE) ? CLAUDE_AMBER : ((kind == KIND_GPT) ? GPT_SILVER : AGY_BLUE);
}

static void extract_model_info(const char *ps, const char *pe, int *out_kind, char mkey[68], char combined_low[256]) {
  *out_kind = KIND_GOOGLE;
  mkey[0] = '\0';
  combined_low[0] = '\0';
  const char *mv = json_get_prop(ps, pe, "model");
  if (!mv) return;
  char mid[128] = "", mdn[128] = "";
  if (*mv == '"') {
    json_read_str(mv, pe, mid, sizeof(mid));
  } else {
    const char *ms, *me;
    if (json_obj_bounds(mv, pe, &ms, &me)) {
      json_read_str(json_get_prop(ms, me, "id"), me, mid, sizeof(mid));
      json_read_str(json_get_prop(ms, me, "display_name"), me, mdn, sizeof(mdn));
    }
  }
  snprintf(combined_low, 256, "%s %s", mid, mdn);
  for (size_t i = 0; combined_low[i]; i++) {
    if ((unsigned char)combined_low[i] < 0x80) combined_low[i] = (char)tolower((unsigned char)combined_low[i]);
  }
  if (strstr(combined_low, "gpt") || strstr(combined_low, "openai")) *out_kind = KIND_GPT;
  else if (strstr(combined_low, "claude") || strstr(combined_low, "anthropic")) *out_kind = KIND_CLAUDE;
  sanitize_model_key(mid[0] ? mid : mdn, mkey, 68);
}

static long long infer_model_window_tokens(const char *combined_low) {
  if (!combined_low || !*combined_low) return 0;
  if (strstr(combined_low, "[2m]") || strstr(combined_low, "-2m") || strstr(combined_low, " 2m")) return 2000000LL;
  if (strstr(combined_low, "[1m]") || strstr(combined_low, "-1m") || strstr(combined_low, " 1m")) return 1000000LL;
  if (strstr(combined_low, "gemini") || strstr(combined_low, "orchestrator")) return 1000000LL;
  if (strstr(combined_low, "gpt-oss") || strstr(combined_low, "128k")) return 131072LL;
  if (strstr(combined_low, "claude") || strstr(combined_low, "anthropic")) return 200000LL;
  return 0;
}

static long long read_window_cache_file(const char *path) {
  char *raw = read_file_str(path, 1024);
  if (!raw) return 0;
  double v = 0;
  long long res = 0;
  if (json_read_num(json_get_prop(raw, raw + strlen(raw), "windowTokens"), raw + strlen(raw), &v) && isfinite(v) && v > 0) {
    res = (long long)llround(v);
  }
  free(raw);
  return res;
}

typedef struct {
  char id[64];
  char label[48];
  double pct_used;
  double reset_sec;
  long long resets_at_ms;
  bool has_reset;
} QuotaBucket;

static void bucket_label(const char *raw_id, double reset_sec, bool has_reset, char out[48]) {
  char clean_id[96];
  sanitize_inline_utf8(raw_id, clean_id, sizeof(clean_id), 0);
  if (contains_icase(clean_id, "5h") || contains_icase(clean_id, "five_hour") || contains_icase(clean_id, "session")) {
    strcpy(out, "5h");
    return;
  }
  size_t ilen = strlen(clean_id);
  bool ends_wk = ilen >= 2 && strncasecmp(clean_id + ilen - 2, "wk", 2) == 0;
  if (contains_icase(clean_id, "week") || contains_icase(clean_id, "seven_day") || ends_wk) {
    strcpy(out, "week");
    return;
  }
  if (has_reset && reset_sec > 0 && reset_sec <= 21600) {
    strcpy(out, "5h");
    return;
  }
  const char *s = clean_id;
  if (strncasecmp(s, "gemini-", 7) == 0) s += 7;
  else if (strncasecmp(s, "antigravity-", 12) == 0) s += 12;
  else if (strncasecmp(s, "3p-", 3) == 0) s += 3;
  else if (strncasecmp(s, "claude-", 7) == 0) s += 7;
  else if (strncasecmp(s, "gpt-", 4) == 0) s += 4;
  sanitize_inline_utf8(s, out, 48, 10);
}

static int resolve_bucket_kind(const char *id_or_label, int model_kind, const char *tp_theme) {
  if (contains_icase(id_or_label, "gpt") || contains_icase(id_or_label, "openai")) return KIND_GPT;
  if (contains_icase(id_or_label, "claude") || contains_icase(id_or_label, "anthropic")) return KIND_CLAUDE;
  if (strncasecmp(id_or_label, "3p", 2) == 0 || contains_icase(id_or_label, "3p-") || contains_icase(id_or_label, "third")) {
    if (tp_theme && strcasecmp(tp_theme, "gpt") == 0) return KIND_GPT;
    if (tp_theme && strcasecmp(tp_theme, "claude") == 0) return KIND_CLAUDE;
    return (model_kind == KIND_GPT) ? KIND_GPT : KIND_CLAUDE;
  }
  return KIND_GOOGLE;
}

static int parse_quotas_obj(const char *qs, const char *qe, long long now_ms, QuotaBucket *out, int max_b) {
  const char *p = skip_ws(qs, qe);
  if (p >= qe || *p != '{') return 0;
  p++;
  int count = 0;
  while (p < qe && count < max_b) {
    p = skip_ws(p, qe);
    if (p >= qe || *p == '}') break;
    if (*p == ',') { p++; continue; }
    if (*p != '"') break;
    char raw_id[96] = "", id[64] = "";
    json_read_str(p, qe, raw_id, sizeof(raw_id));
    sanitize_inline_utf8(raw_id, id, sizeof(id), 0);
    p = skip_ws(skip_json_string(p, qe), qe);
    if (p >= qe || *p != ':') break;
    p = skip_ws(p + 1, qe);
    const char *es, *ee;
    if (json_obj_bounds(p, qe, &es, &ee)) {
      if (json_read_bool(json_get_prop(es, ee, "disabled"), ee) != 1) {
        double rem = 0, used = 0, rsec = 0;
        bool ok = false;
        if (json_read_num(json_get_prop(es, ee, "remaining_fraction"), ee, &rem) && isfinite(rem)) {
          used = (1.0 - rem) * 100.0;
          ok = true;
        } else if (json_read_num(json_get_prop(es, ee, "used_percentage"), ee, &used) && isfinite(used)) {
          ok = true;
        }
        if (ok) {
          if (used < 0) used = 0;
          if (used > 100) used = 100;
          bool has_rsec = json_read_num(json_get_prop(es, ee, "reset_in_seconds"), ee, &rsec) && isfinite(rsec);
          if (has_rsec) {
            if (rsec < 0) rsec = 0;
            if (rsec > 315360000.0) rsec = 315360000.0;
          }
          char rtime_str[64] = "";
          long long parsed_ms = 0;
          bool has_rtime = json_read_str(json_get_prop(es, ee, "reset_time"), ee, rtime_str, sizeof(rtime_str)) &&
                           parse_iso8601_ms(rtime_str, &parsed_ms);
          bool hr = false;
          long long rams = 0;
          if (has_rsec) {
            hr = true;
            rams = has_rtime ? parsed_ms : (now_ms + (long long)llround(rsec * 1000.0));
          } else if (has_rtime) {
            double diff_s = floor(((double)(parsed_ms - now_ms)) / 1000.0 + 0.5);
            if (diff_s < 0) diff_s = 0;
            if (diff_s > 315360000.0) diff_s = 315360000.0;
            rsec = diff_s;
            hr = true;
            rams = parsed_ms;
          }
          int slot = count;
          for (int k = 0; k < count; k++) {
            if (strcmp(out[k].id, id) == 0) { slot = k; break; }
          }
          snprintf(out[slot].id, sizeof(out[slot].id), "%s", id);
          out[slot].pct_used = used;
          out[slot].reset_sec = hr ? rsec : 0;
          out[slot].has_reset = hr;
          out[slot].resets_at_ms = hr ? rams : 0;
          bucket_label(id, out[slot].reset_sec, hr, out[slot].label);
          if (slot == count) count++;
        }
      }
    }
    p = skip_json_value(p, qe);
  }
  return count;
}

static int read_cached_quotas(const char *cr, QuotaBucket *out, int max_b, long long *out_at) {
  const char *ce = cr + strlen(cr);
  double atv = 0;
  if (out_at && json_read_num(json_get_prop(cr, ce, "at"), ce, &atv) && isfinite(atv)) *out_at = (long long)atv;
  const char *arr = json_get_prop(cr, ce, "buckets");
  if (!arr || *arr != '[') return 0;
  const char *ae = skip_json_value(arr, ce);
  const char *p = arr + 1;
  int nb = 0;
  while (p < ae && nb < max_b) {
    p = skip_ws(p, ae);
    if (p >= ae || *p == ']') break;
    if (*p == ',') { p++; continue; }
    const char *bs, *be;
    if (json_obj_bounds(p, ae, &bs, &be)) {
      char raw_lbl[64] = "";
      if (json_read_str(json_get_prop(bs, be, "label"), be, raw_lbl, sizeof(raw_lbl)) &&
          json_read_num(json_get_prop(bs, be, "percentUsed"), be, &out[nb].pct_used) && isfinite(out[nb].pct_used)) {
        sanitize_inline_utf8(raw_lbl, out[nb].label, sizeof(out[nb].label), 10);
        char raw_id[96] = "";
        out[nb].id[0] = '\0';
        if (json_read_str(json_get_prop(bs, be, "id"), be, raw_id, sizeof(raw_id))) {
          sanitize_inline_utf8(raw_id, out[nb].id, sizeof(out[nb].id), 0);
        }
        out[nb].has_reset = json_read_num(json_get_prop(bs, be, "resetSec"), be, &out[nb].reset_sec) && isfinite(out[nb].reset_sec);
        double rams = 0;
        long long iso_ms = 0;
        char rstr[64] = "";
        if (json_read_num(json_get_prop(bs, be, "resetsAtMs"), be, &rams) && isfinite(rams) && rams > 0) {
          out[nb].resets_at_ms = (long long)rams;
        } else if (json_read_str(json_get_prop(bs, be, "resetsAt"), be, rstr, sizeof(rstr)) && parse_iso8601_ms(rstr, &iso_ms)) {
          out[nb].resets_at_ms = iso_ms;
        } else {
          out[nb].resets_at_ms = 0;
        }
        nb++;
      }
    }
    p = skip_json_value(p, ae);
  }
  return nb;
}

static const char *pick_family_icon(int kind, bool is_idle, long long now_ms) {
  static const char *const seq_google[10] = {
    "\xc2\xb7", "\xe2\x9c\xa7", "\xe2\x9c\xa6", "\xe2\x97\x87", "\xe2\x97\x88",
    "\xe2\x9d\x96", "\xe2\x97\x88", "\xe2\x97\x87", "\xe2\x9c\xa6", "\xe2\x9c\xa7"
  };
  static const char *const seq_claude[10] = {
    "\xc2\xb7", "\xe2\x9c\xa2", "\xe2\x9c\xb3", "\xe2\x9c\xb6", "\xe2\x9c\xbb",
    "\xe2\x9c\xbd", "\xe2\x9c\xbb", "\xe2\x9c\xb6", "\xe2\x9c\xb3", "\xe2\x9c\xa2"
  };
  static const char *const seq_gpt[10] = {
    "\xc2\xb7", "\xe2\x88\x98", "\xe2\x97\x8b", "\xe2\x97\x8e", "\xe2\x97\x89",
    "\xe2\x9d\x82", "\xe2\x97\x89", "\xe2\x97\x8e", "\xe2\x97\x8b", "\xe2\x88\x98"
  };
  if (is_idle) return static_family_icon(kind);
  long long idx = (now_ms / 300LL) % 10LL;
  if (idx < 0) idx += 10LL;
  if (kind == KIND_CLAUDE) return seq_claude[idx];
  if (kind == KIND_GPT) return seq_gpt[idx];
  return seq_google[idx];
}

static void fmt_quota_window(const QuotaBucket *w, int kind, bool is_idle, long long now_ms, bool with_bar, bool with_reset, char *out, size_t cap) {
  const char *icon = pick_family_icon(kind, is_idle, now_ms);
  const char *icol = family_icon_color(kind);
  const char *base_bcol = (kind == KIND_CLAUDE) ? CLAUDE_AMBER : ((kind == KIND_GPT) ? GPT_SLATE : AGY_BLUE);
  double cl = (!isfinite(w->pct_used) || w->pct_used < 0) ? 0 : (w->pct_used > 100 ? 100 : w->pct_used);
  int pct = clamp_double_to_int(floor(w->pct_used + 0.5), 0, 100);
  int filled = clamp_double_to_int(floor((cl / 100.0) * 10.0 + 0.5), 0, 10);
  const char *bcol = pct >= 90 ? RED : (pct >= 75 ? YELLOW : base_bcol);
  char bar[160] = "";
  if (with_bar) {
    size_t o = 0;
    o += (size_t)snprintf(bar + o, sizeof(bar) - o, " %s", bcol);
    for (int i = 0; i < filled; i++) { memcpy(bar + o, "\xe2\x94\x81", 3); o += 3; }
    o += (size_t)snprintf(bar + o, sizeof(bar) - o, "%s%s", R, DIM);
    for (int i = 0; i < 10 - filled; i++) { memcpy(bar + o, "\xe2\x94\x80", 3); o += 3; }
    snprintf(bar + o, sizeof(bar) - o, "%s", R);
  }
  char rst[64] = "";
  if (with_reset && w->has_reset && w->reset_sec > 0) {
    char u[32];
    format_until(w->reset_sec, u);
    if (u[0]) snprintf(rst, sizeof(rst), "%s \xe2\x86\xbb %s%s", DIM, u, R);
  }
  snprintf(out, cap, "%s%s%s %s%s%s%s %d%%%s", icol, icon, R, DIM, w->label, R, bar, pct, rst);
}

static void append_str(char *dst, size_t cap, const char *src) {
  size_t dlen = strlen(dst);
  if (dlen + 1 >= cap) return;
  size_t slen = strlen(src);
  size_t room = cap - 1 - dlen;
  if (slen > room) slen = room;
  memcpy(dst + dlen, src, slen);
  dst[dlen + slen] = '\0';
}

static bool plugin_installed_and_enabled(const char *name, char (*installed)[260], int n_inst, const char *g_ps, const char *g_pe) {
  bool found = false;
  for (int i = 0; i < n_inst; i++) {
    if (strcmp(installed[i], name) == 0) { found = true; break; }
  }
  if (!found) return false;
  if (g_ps && g_pe) {
    const char *ps, *pe;
    if (json_obj_bounds(json_get_prop(g_ps, g_pe, name), g_pe, &ps, &pe)) {
      if (json_read_bool(json_get_prop(ps, pe, "enabled"), pe) == 0) return false;
    }
  }
  return true;
}

static bool is_narrator_worker_alive(pid_t pid, long long started_at, long long now_ms) {
  if (pid <= 0) return false;
  if (kill(pid, 0) != 0 && errno != EPERM) return false;
  if (access("/proc/self/cmdline", R_OK) == 0) {
    char ppath[64];
    snprintf(ppath, sizeof(ppath), "/proc/%d/cmdline", (int)pid);
    int fd = open(ppath, O_RDONLY);
    if (fd < 0) return false;
    char cmd[4096];
    ssize_t n = read(fd, cmd, sizeof(cmd) - 1);
    close(fd);
    if (n <= 0) return false;
    for (ssize_t i = 0; i < n; i++) {
      if (cmd[i] == '\0') cmd[i] = ' ';
    }
    cmd[n] = '\0';
    return strstr(cmd, "speak-worker") != NULL;
  }
  if (started_at > 0 && now_ms - started_at > 180000LL) return false;
  return true;
}

int main(void) {
  const char *home = getenv("BETTER_AGY_TEST_HOME");
  if (!home || !*home) home = getenv("HOME");
  if (!home) home = "/root";

  char root_dir[PATH_MAX], plugins_dir[PATH_MAX], cfg_json_path[PATH_MAX];
  const char *env_root = getenv("BETTER_AGY_HOME");
  if (env_root && *env_root) snprintf(root_dir, sizeof(root_dir), "%s", env_root);
  else snprintf(root_dir, sizeof(root_dir), "%s/.gemini/antigravity-cli/better-antigravity", home);

  const char *env_plug = getenv("BETTER_AGY_PLUGINS_DIR");
  if (env_plug && *env_plug) snprintf(plugins_dir, sizeof(plugins_dir), "%s", env_plug);
  else snprintf(plugins_dir, sizeof(plugins_dir), "%s/.gemini/config/plugins", home);

  const char *env_cfg = getenv("BETTER_AGY_CONFIG_JSON");
  if (env_cfg && *env_cfg) snprintf(cfg_json_path, sizeof(cfg_json_path), "%s", env_cfg);
  else snprintf(cfg_json_path, sizeof(cfg_json_path), "%s/.gemini/config/config.json", home);

  DIR *dp = opendir(plugins_dir);
  if (!dp) return 0;
  int inst_cap = 64, n_inst = 0;
  char (*installed)[260] = (char (*)[260])malloc((size_t)inst_cap * sizeof(*installed));
  if (!installed) { closedir(dp); return 0; }
  struct dirent *de;
  while ((de = readdir(dp)) != NULL) {
    if (de->d_name[0] == '.') continue;
    if (n_inst >= inst_cap) {
      int next_cap = inst_cap * 2;
      char (*grown)[260] = (char (*)[260])realloc(installed, (size_t)next_cap * sizeof(*installed));
      if (!grown) break;
      installed = grown;
      inst_cap = next_cap;
    }
    snprintf(installed[n_inst++], sizeof(installed[0]), "%s", de->d_name);
  }
  closedir(dp);
  if (n_inst == 0) { free(installed); return 0; }

  char *payload = read_stdin_all();
  const char *ps = payload ? payload : "{}";
  const char *pe = ps + strlen(ps);

  char *global_raw = read_file_str(cfg_json_path, 65536);
  const char *g_ps = NULL, *g_pe = NULL;
  if (global_raw) {
    const char *ge = global_raw + strlen(global_raw);
    json_obj_bounds(json_get_prop(global_raw, ge, "plugins"), ge, &g_ps, &g_pe);
  }

  char pcfg_path[PATH_MAX + 256];
  snprintf(pcfg_path, sizeof(pcfg_path), "%s/config.json", root_dir);
  char *all_cfg_raw = read_file_str(pcfg_path, 65536);
  const char *ac_ps = NULL, *ac_pe = NULL;
  if (all_cfg_raw) {
    const char *ae = all_cfg_raw + strlen(all_cfg_raw);
    json_obj_bounds(json_get_prop(all_cfg_raw, ae, "plugins"), ae, &ac_ps, &ac_pe);
  }

  long long now_ms = 0;
  const char *env_now = getenv("BETTER_AGY_NOW_MS");
  if (env_now && *env_now) now_ms = atoll(env_now);
  if (now_ms <= 0) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    now_ms = (long long)tv.tv_sec * 1000LL + tv.tv_usec / 1000LL;
  }

  char raw_sid[128] = "", sid[68] = "";
  if (!json_read_str(json_get_prop(ps, pe, "conversation_id"), pe, raw_sid, sizeof(raw_sid))) {
    json_read_str(json_get_prop(ps, pe, "session_id"), pe, raw_sid, sizeof(raw_sid));
  }
  sanitize_sid(raw_sid, sid, sizeof(sid));

  int model_kind = KIND_GOOGLE;
  char model_key[68] = "", model_combined[256] = "";
  extract_model_info(ps, pe, &model_kind, model_key, model_combined);
  const char *family_name = (model_kind == KIND_CLAUDE) ? "claude" : ((model_kind == KIND_GPT) ? "gpt" : "google");

  char cwd[PATH_MAX] = "";
  const char *ws_s, *ws_e;
  if (json_obj_bounds(json_get_prop(ps, pe, "workspace"), pe, &ws_s, &ws_e)) {
    json_read_str(json_get_prop(ws_s, ws_e, "project_dir"), ws_e, cwd, sizeof(cwd));
  }
  if (!cwd[0] && !json_read_str(json_get_prop(ps, pe, "cwd"), pe, cwd, sizeof(cwd))) {
    if (!getcwd(cwd, sizeof(cwd))) strcpy(cwd, "/");
  }
  char rkey[13] = "";

  const char *cw_s = NULL, *cw_e = NULL;
  json_obj_bounds(json_get_prop(ps, pe, "context_window"), pe, &cw_s, &cw_e);

  /* Persist race-free per-model and per-session context window caches when changed */
  long long live_win = 0;
  double live_win_d = 0;
  char cw_dir[PATH_MAX + 128];
  snprintf(cw_dir, sizeof(cw_dir), "%s/context-windows", root_dir);
  if (cw_s && json_read_num(json_get_prop(cw_s, cw_e, "context_window_size"), cw_e, &live_win_d) && isfinite(live_win_d) && live_win_d > 0) {
    live_win = (long long)llround(live_win_d);
    if (model_key[0]) {
      char mpath[PATH_MAX + 256];
      snprintf(mpath, sizeof(mpath), "%s/model-%s.json", cw_dir, model_key);
      if (read_window_cache_file(mpath) != live_win) {
        mkdir_p_private(cw_dir);
        char mjson[256];
        snprintf(mjson, sizeof(mjson), "{\n  \"model\": \"%s\",\n  \"family\": \"%s\",\n  \"windowTokens\": %lld\n}\n",
                 model_key, family_name, live_win);
        (void)write_atomic_file_0600(mpath, mjson);
      }
    }
    if (sid[0]) {
      char spath[PATH_MAX + 256];
      snprintf(spath, sizeof(spath), "%s/sess-%s.json", cw_dir, sid);
      char *sr = read_file_str(spath, 1024);
      long long prev_sw = 0;
      char prev_sm[68] = "";
      if (sr) {
        double pv = 0;
        const char *se = sr + strlen(sr);
        if (json_read_num(json_get_prop(sr, se, "windowTokens"), se, &pv) && isfinite(pv)) prev_sw = (long long)llround(pv);
        json_read_str(json_get_prop(sr, se, "model"), se, prev_sm, sizeof(prev_sm));
        free(sr);
      }
      if (prev_sw != live_win || (model_key[0] && strcmp(prev_sm, model_key) != 0)) {
        mkdir_p_private(cw_dir);
        char sjson[256];
        snprintf(sjson, sizeof(sjson), "{\n  \"model\": \"%s\",\n  \"family\": \"%s\",\n  \"windowTokens\": %lld\n}\n",
                 model_key[0] ? model_key : prev_sm, family_name, live_win);
        (void)write_atomic_file_0600(spath, sjson);
      }
    }
  }

  Widget widgets[8];
  int nw = 0;

  /* 1. Context Meter */
  if (plugin_installed_and_enabled("context-meter", installed, n_inst, g_ps, g_pe)) {
    double warn_at = 50, danger_at = 75, cfg_win = 0;
    const char *cs, *ce;
    if (ac_ps && json_obj_bounds(json_get_prop(ac_ps, ac_pe, "context-meter"), ac_pe, &cs, &ce)) {
      json_read_num(json_get_prop(cs, ce, "warnAt"), ce, &warn_at);
      json_read_num(json_get_prop(cs, ce, "dangerAt"), ce, &danger_at);
      json_read_num(json_get_prop(cs, ce, "windowTokens"), ce, &cfg_win);
    }

    long long eff_win = live_win;
    if (eff_win <= 0 && isfinite(cfg_win) && cfg_win > 0) eff_win = (long long)llround(cfg_win);
    if (eff_win <= 0 && model_key[0]) {
      char mpath[PATH_MAX + 256];
      snprintf(mpath, sizeof(mpath), "%s/model-%s.json", cw_dir, model_key);
      eff_win = read_window_cache_file(mpath);
    }
    if (eff_win <= 0 && sid[0]) {
      char spath[PATH_MAX + 256];
      snprintf(spath, sizeof(spath), "%s/sess-%s.json", cw_dir, sid);
      eff_win = read_window_cache_file(spath);
    }
    if (eff_win <= 0) eff_win = infer_model_window_tokens(model_combined);
    if (eff_win <= 0) eff_win = 200000LL;

    double pct = -1;
    bool is_est = false;
    if (cw_s) {
      double up = 0;
      const char *cu = json_get_prop(cw_s, cw_e, "current_usage");
      bool cu_not_null = cu && !(cw_e - cu >= 4 && memcmp(cu, "null", 4) == 0);
      if (json_read_num(json_get_prop(cw_s, cw_e, "used_percentage"), cw_e, &up) &&
          isfinite(up) && up >= 0 && (cu_not_null || up > 0)) {
        pct = up > 100.0 ? 100.0 : up;
      }
    }
    if (pct < 0) {
      char raw_tpath[PATH_MAX] = "", tpath[PATH_MAX + 256] = "";
      if (json_read_str(json_get_prop(ps, pe, "transcript_path"), pe, raw_tpath, sizeof(raw_tpath)) && raw_tpath[0]) {
        expand_tilde(raw_tpath, home, tpath, sizeof(tpath));
        struct stat st;
        if (stat(tpath, &st) == 0) {
          double est = floor((double)st.st_size / 4.0 + 0.5);
          pct = (est / (double)eff_win) * 100.0;
          if (pct > 99.0) pct = 99.0;
          is_est = true;
        }
      }
    }
    if (pct >= 0) {
      int rounded = clamp_double_to_int(floor(pct + 0.5), 0, 100);
      char win_lbl[24];
      short_window_label(eff_win, win_lbl);
      const char *ic = static_family_icon(model_kind);
      const char *icol = family_icon_color(model_kind);
      const char *pfx = is_est ? "~" : "";
      const char *col = pct >= danger_at ? RED BOLD : (pct >= warn_at ? YELLOW : DIM);
      const char *hint = pct >= danger_at ? " · new session" : (pct >= warn_at ? " · /compact" : "");
      snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s%s%s %scontext %s%d%%/%s%s%s", icol, ic, R, col, pfx, rounded, win_lbl, hint, R);
      snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%s%s%s %sctx %s%d%%/%s%s", icol, ic, R, col, pfx, rounded, win_lbl, R);
      snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s%s%s%s%s%d%%/%s%s", icol, ic, R, col, pfx, rounded, win_lbl, R);
      nw++;
    }
  }

  /* 2. Token Meter */
  if (plugin_installed_and_enabled("token-meter", installed, n_inst, g_ps, g_pe)) {
    double last_in = -1, last_out = 0, last_cache = 0;
    const char *us, *ue;
    if (cw_s && json_obj_bounds(json_get_prop(cw_s, cw_e, "current_usage"), cw_e, &us, &ue)) {
      last_in = 0;
      json_read_num(json_get_prop(us, ue, "input_tokens"), ue, &last_in);
      json_read_num(json_get_prop(us, ue, "output_tokens"), ue, &last_out);
      double cr = 0, cc = 0;
      json_read_num(json_get_prop(us, ue, "cache_read_input_tokens"), ue, &cr);
      json_read_num(json_get_prop(us, ue, "cache_creation_input_tokens"), ue, &cc);
      last_cache = cr + cc;
    } else if (sid[0]) {
      char tf[PATH_MAX + 256];
      snprintf(tf, sizeof(tf), "%s/tokens/%s.json", root_dir, sid);
      char *tr = read_file_str(tf, 65536);
      if (tr) {
        const char *te = tr + strlen(tr), *ls, *le;
        if (json_obj_bounds(json_get_prop(tr, te, "last"), te, &ls, &le)) {
          last_in = 0;
          json_read_num(json_get_prop(ls, le, "input"), le, &last_in);
          json_read_num(json_get_prop(ls, le, "output"), le, &last_out);
          json_read_num(json_get_prop(ls, le, "cached"), le, &last_cache);
        }
        free(tr);
      }
    }
    if (last_in >= 0) {
      double tot_in = 0, tot_out = 0;
      if (cw_s) {
        json_read_num(json_get_prop(cw_s, cw_e, "total_input_tokens"), cw_e, &tot_in);
        json_read_num(json_get_prop(cw_s, cw_e, "total_output_tokens"), cw_e, &tot_out);
      }
      if (tot_in <= 0) tot_in = last_in;
      if (tot_out <= 0) tot_out = last_out;
      char s_in[32], s_out[32], s_ca[32], s_tin[32], s_tout[32];
      short_tokens(last_in, s_in);
      short_tokens(last_out, s_out);
      short_tokens(last_cache, s_ca);
      short_tokens(tot_in, s_tin);
      short_tokens(tot_out, s_tout);
      char turn_part[256];
      if (last_cache > 0) {
        snprintf(turn_part, sizeof(turn_part), "%s↑%s %s  %s↓%s %s  %scache%s %s", BLUE, R, s_in, GREEN, R, s_out, AGY_SKY, R, s_ca);
      } else {
        snprintf(turn_part, sizeof(turn_part), "%s↑%s %s  %s↓%s %s", BLUE, R, s_in, GREEN, R, s_out);
      }
      snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s%s  ·  session ↑ %s  ↓ %s%s", turn_part, DIM, s_tin, s_tout, R);
      snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%s", turn_part);
      snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s↑%s%s %s↓%s%s", BLUE, R, s_in, GREEN, R, s_out);
      nw++;
    }
  }

  /* 3. Sub Meter */
  if (plugin_installed_and_enabled("sub-meter", installed, n_inst, g_ps, g_pe)) {
    QuotaBucket buckets[8];
    int nb = 0;
    const char *qs, *qe;
    if (json_obj_bounds(json_get_prop(ps, pe, "quota"), pe, &qs, &qe)) {
      nb = parse_quotas_obj(qs, qe, now_ms, buckets, 8);
    }
    char cpath[PATH_MAX + 256];
    snprintf(cpath, sizeof(cpath), "%s/quota-cache.json", root_dir);
    char *cr = read_file_str(cpath, 32768);
    QuotaBucket cached_b[8];
    long long cached_at = 0;
    int cached_nb = cr ? read_cached_quotas(cr, cached_b, 8, &cached_at) : 0;
    free(cr);

    if (nb > 0) {
      bool should_write = (cached_nb != nb) || (now_ms - cached_at >= 30000);
      if (!should_write) {
        for (int i = 0; i < nb; i++) {
          if (clamp_double_to_int(floor(cached_b[i].pct_used + 0.5), -1, 100) !=
              clamp_double_to_int(floor(buckets[i].pct_used + 0.5), -1, 100)) {
            should_write = true;
            break;
          }
        }
      }
      if (should_write) {
        mkdir_p_private(root_dir);
        char tmpp[PATH_MAX + 300];
        snprintf(tmpp, sizeof(tmpp), "%s.tmp-%d", cpath, (int)getpid());
        int cfd = open(tmpp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (cfd >= 0) {
          FILE *cf = fdopen(cfd, "wb");
          if (cf) {
            fprintf(cf, "{\n  \"at\": %lld,\n  \"buckets\": [\n", now_ms);
            for (int i = 0; i < nb; i++) {
              fprintf(cf, "    {\"id\": ");
              fprint_json_str(cf, buckets[i].id);
              fprintf(cf, ", \"label\": ");
              fprint_json_str(cf, buckets[i].label);
              fprintf(cf, ", \"percentUsed\": %.4f", buckets[i].pct_used);
              if (buckets[i].has_reset) {
                fprintf(cf, ", \"resetSec\": %.0f, \"resetsAtMs\": %lld", buckets[i].reset_sec, buckets[i].resets_at_ms);
              } else {
                fprintf(cf, ", \"resetSec\": null, \"resetsAtMs\": null");
              }
              fprintf(cf, "}%s\n", (i + 1 < nb) ? "," : "");
            }
            fprintf(cf, "  ]\n}\n");
            bool write_ok = (ferror(cf) == 0 && fflush(cf) == 0);
            if (fclose(cf) == 0 && write_ok) {
              if (rename(tmpp, cpath) != 0) unlink(tmpp);
            } else {
              unlink(tmpp);
            }
          } else {
            close(cfd);
            unlink(tmpp);
          }
        }
      }
    } else if (cached_nb > 0) {
      nb = cached_nb;
      for (int i = 0; i < nb; i++) {
        buckets[i] = cached_b[i];
        if (buckets[i].resets_at_ms > 0) {
          if (buckets[i].resets_at_ms <= now_ms) {
            buckets[i].pct_used = 0;
            buckets[i].reset_sec = 0;
          } else {
            buckets[i].reset_sec = floor((double)(buckets[i].resets_at_ms - now_ms) / 1000.0 + 0.5);
            buckets[i].has_reset = true;
          }
        }
        const char *key = buckets[i].id[0] ? buckets[i].id : buckets[i].label;
        bucket_label(key, buckets[i].reset_sec, buckets[i].has_reset, buckets[i].label);
      }
    }

    if (nb > 0) {
      char disp[16] = "rotate";
      char tp_theme[16] = "auto";
      double rot_sec = 4;
      const char *ss, *se;
      if (ac_ps && json_obj_bounds(json_get_prop(ac_ps, ac_pe, "sub-meter"), ac_pe, &ss, &se)) {
        json_read_str(json_get_prop(ss, se, "display"), se, disp, sizeof(disp));
        json_read_str(json_get_prop(ss, se, "thirdPartyTheme"), se, tp_theme, sizeof(tp_theme));
        double rs = 0;
        if (json_read_num(json_get_prop(ss, se, "rotateSeconds"), se, &rs) && isfinite(rs) && rs > 0) rot_sec = rs;
      }
      QuotaBucket chosen[8];
      int nc = 0;
      if (nb >= 2 && strcmp(disp, "both") != 0) {
        if (strcmp(disp, "session") == 0) {
          for (int i = 0; i < nb; i++) {
            if (strstr(buckets[i].label, "5h") ||
                (strcmp(buckets[i].label, "week") != 0 && buckets[i].has_reset && buckets[i].reset_sec > 0 && buckets[i].reset_sec <= 21600)) {
              chosen[nc++] = buckets[i];
            }
          }
        } else if (strcmp(disp, "week") == 0) {
          for (int i = 0; i < nb; i++) {
            if (strstr(buckets[i].label, "week") || strstr(buckets[i].label, "wk")) {
              chosen[nc++] = buckets[i];
            }
          }
        } else {
          long long idx = ((long long)floor((double)now_ms / (rot_sec * 1000.0))) % nb;
          if (idx < 0) idx += nb;
          chosen[nc++] = buckets[idx];
        }
      }
      if (nc == 0) {
        for (int i = 0; i < nb; i++) chosen[nc++] = buckets[i];
      }

      char astate_sm[32] = "";
      json_read_str(json_get_prop(ps, pe, "agent_state"), pe, astate_sm, sizeof(astate_sm));
      bool is_idle_sm = (strcmp(astate_sm, "idle") == 0);

      widgets[nw].full[0] = widgets[nw].compact[0] = widgets[nw].minimal[0] = '\0';
      for (int i = 0; i < nc; i++) {
        const char *bkey = chosen[i].id[0] ? chosen[i].id : chosen[i].label;
        int kind = resolve_bucket_kind(bkey, model_kind, tp_theme);
        char pf[256], pc[128], pm[96];
        fmt_quota_window(&chosen[i], kind, is_idle_sm, now_ms, true, true, pf, sizeof(pf));
        fmt_quota_window(&chosen[i], kind, is_idle_sm, now_ms, false, true, pc, sizeof(pc));
        fmt_quota_window(&chosen[i], kind, is_idle_sm, now_ms, false, false, pm, sizeof(pm));
        if (i > 0) {
          append_str(widgets[nw].full, sizeof(widgets[nw].full), DIM "  |  " R);
          append_str(widgets[nw].compact, sizeof(widgets[nw].compact), DIM " | " R);
          append_str(widgets[nw].minimal, sizeof(widgets[nw].minimal), DIM " | " R);
        }
        append_str(widgets[nw].full, sizeof(widgets[nw].full), pf);
        append_str(widgets[nw].compact, sizeof(widgets[nw].compact), pc);
        append_str(widgets[nw].minimal, sizeof(widgets[nw].minimal), pm);
      }
      nw++;
    }
  }

  /* 4. Time Machine */
  if (sid[0] && plugin_installed_and_enabled("time-machine", installed, n_inst, g_ps, g_pe)) {
    if (!rkey[0]) sha1_hex12(cwd, rkey);
    char tmf[PATH_MAX + 256];
    snprintf(tmf, sizeof(tmf), "%s/time-machine/%s/%s.json", root_dir, rkey, sid);
    char *tmr = read_file_str(tmf, STATE_MAX_BYTES);
    if (tmr) {
      const char *tme = tmr + strlen(tmr);
      int max_id = 0;
      double top_max_v = 0;
      if (json_read_num(json_get_prop(tmr, tme, "maxId"), tme, &top_max_v)) {
        max_id = clamp_double_to_int(top_max_v, 0, 1000000000);
      }
      const char *arr = json_get_prop(tmr, tme, "states");
      if (arr && *arr == '[') {
        const char *ae = skip_json_value(arr, tme), *p = arr + 1;
        while (p < ae) {
          p = skip_ws(p, ae);
          if (p >= ae || *p == ']') break;
          if (*p == ',') { p++; continue; }
          const char *os, *oe;
          if (json_obj_bounds(p, ae, &os, &oe)) {
            double idv = 0;
            if (json_read_num(json_get_prop(os, oe, "id"), oe, &idv)) {
              int cid = clamp_double_to_int(idv, 0, 1000000000);
              if (cid > max_id) max_id = cid;
            }
          }
          p = skip_json_value(p, ae);
        }
      }
      if (max_id > 0) {
        double curv = 0;
        int cur = max_id;
        if (json_read_num(json_get_prop(tmr, tme, "cursor"), tme, &curv) && isfinite(curv)) {
          cur = clamp_double_to_int(curv, 0, 1000000000);
        }
        if (cur < max_id) snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏪ #%d/%d%s", YELLOW, cur, max_id, R);
        else snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏪ #%d%s", AGY_BLUE, cur, R);
        strcpy(widgets[nw].compact, widgets[nw].full);
        strcpy(widgets[nw].minimal, widgets[nw].full);
        nw++;
      }
      free(tmr);
    }
  }

  /* 5. After */
  if (plugin_installed_and_enabled("after", installed, n_inst, g_ps, g_pe)) {
    if (!rkey[0]) sha1_hex12(cwd, rkey);
    const char *asid = sid[0] ? sid : "default";
    char af1[PATH_MAX + 256], af2[PATH_MAX + 256];
    snprintf(af1, sizeof(af1), "%s/after/%s-%s.json", root_dir, rkey, asid);
    snprintf(af2, sizeof(af2), "%s/after/%s.json", root_dir, rkey);
    char *ar = read_file_str(af1, STATE_MAX_BYTES);
    if (!ar) ar = read_file_str(af2, STATE_MAX_BYTES);
    if (ar) {
      const char *ae = ar + strlen(ar);
      int count = 0;
      const char *arr = json_get_prop(ar, ae, "items");
      if (arr && *arr == '[') {
        const char *ie = skip_json_value(arr, ae), *p = arr + 1;
        while (p < ie) {
          p = skip_ws(p, ie);
          if (p >= ie || *p == ']') break;
          if (*p == ',') { p++; continue; }
          count++;
          p = skip_json_value(p, ie);
        }
      }
      const char *rs, *re;
      bool has_run = json_obj_bounds(json_get_prop(ar, ae, "running"), ae, &rs, &re);
      bool paused = json_read_bool(json_get_prop(ar, ae, "paused"), ae) == 1;
      if (has_run || count > 0) {
        if (paused) {
          snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏸ after (%d)%s", YELLOW, count, R);
          strcpy(widgets[nw].compact, widgets[nw].full);
          snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s⏸%d%s", YELLOW, count, R);
        } else if (has_run) {
          char raw_rtxt[512] = "", rtxt[160] = "";
          json_read_str(json_get_prop(rs, re, "text"), re, raw_rtxt, sizeof(raw_rtxt));
          sanitize_inline_utf8(raw_rtxt, rtxt, sizeof(rtxt), 22);
          char tail[32] = "";
          if (count > 0) snprintf(tail, sizeof(tail), " · +%d", count);
          snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%safter ▶%s %s%s%s%s", GREEN, R, rtxt, DIM, tail, R);
          snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%safter ▶%s%s", GREEN, tail, R);
          snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s▶+%d%s", GREEN, count, R);
        } else {
          snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%safter%s (%d queued)", CYAN, R, count);
          snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%safter (%d)%s", CYAN, count, R);
          snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s+%d%s", CYAN, count, R);
        }
        nw++;
      }
      free(ar);
    }
  }

  /* 6. Turn Mode Badges (Think Hard / Use Hydrogen) */
  if (sid[0] && (plugin_installed_and_enabled("think-hard", installed, n_inst, g_ps, g_pe) ||
                 plugin_installed_and_enabled("use-hydrogen", installed, n_inst, g_ps, g_pe))) {
    char astate[32] = "";
    json_read_str(json_get_prop(ps, pe, "agent_state"), pe, astate, sizeof(astate));
    if (strcmp(astate, "idle") != 0) {
      bool th = false, uh = false;
      char f_th[PATH_MAX + 256], f_uh[PATH_MAX + 256], f_leg[PATH_MAX + 256];
      snprintf(f_th, sizeof(f_th), "%s/turn-flags/think-hard-%s.json", root_dir, sid);
      snprintf(f_uh, sizeof(f_uh), "%s/turn-flags/use-hydrogen-%s.json", root_dir, sid);
      snprintf(f_leg, sizeof(f_leg), "%s/turn-flags/%s.json", root_dir, sid);
      char *r_th = read_file_str(f_th, 1024);
      char *r_uh = read_file_str(f_uh, 1024);
      if (r_th) { th = json_read_bool(json_get_prop(r_th, r_th + strlen(r_th), "thinkHard"), r_th + strlen(r_th)) == 1; free(r_th); }
      if (r_uh) { uh = json_read_bool(json_get_prop(r_uh, r_uh + strlen(r_uh), "useHydrogen"), r_uh + strlen(r_uh)) == 1; free(r_uh); }
      if (!th && !uh) {
        char *r_lg = read_file_str(f_leg, 1024);
        if (r_lg) {
          const char *le = r_lg + strlen(r_lg);
          th = json_read_bool(json_get_prop(r_lg, le, "thinkHard"), le) == 1;
          uh = json_read_bool(json_get_prop(r_lg, le, "useHydrogen"), le) == 1;
          free(r_lg);
        }
      }
      if (th || uh) {
        snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s%s%s",
                 th ? MAGENTA BOLD "+MAX" R : "",
                 (th && uh) ? " " : "",
                 uh ? CYAN BOLD "_Hydrogen" R : "");
        strcpy(widgets[nw].compact, widgets[nw].full);
        strcpy(widgets[nw].minimal, widgets[nw].full);
        nw++;
      }
    }
  }

  /* 7. Narrator */
  if (plugin_installed_and_enabled("narrator", installed, n_inst, g_ps, g_pe)) {
    bool enabled = false;
    char raw_lang[64] = "", lang[48] = "";
    const char *ns, *ne;
    if (ac_ps && json_obj_bounds(json_get_prop(ac_ps, ac_pe, "narrator"), ac_pe, &ns, &ne)) {
      enabled = json_read_bool(json_get_prop(ns, ne, "enabled"), ne) == 1;
      json_read_str(json_get_prop(ns, ne, "language"), ne, raw_lang, sizeof(raw_lang));
    }
    sanitize_inline_utf8(raw_lang, lang, sizeof(lang), 12);
    for (size_t i = 0; lang[i]; i++) {
      if ((unsigned char)lang[i] < 0x80) lang[i] = (char)toupper((unsigned char)lang[i]);
    }
    char ltag[64] = "";
    if (lang[0]) snprintf(ltag, sizeof(ltag), " · %s", lang);

    bool speaking = false;
    char rf[PATH_MAX + 256];
    snprintf(rf, sizeof(rf), "%s/narrator-runtime.json", root_dir);
    char *rr = read_file_str(rf, 4096);
    if (rr) {
      const char *re = rr + strlen(rr);
      double pidv = 0, startv = 0;
      json_read_num(json_get_prop(rr, re, "startedAt"), re, &startv);
      if (json_read_num(json_get_prop(rr, re, "speakingPid"), re, &pidv) && isfinite(pidv) && pidv > 0) {
        pid_t spid = (pid_t)clamp_double_to_int(pidv, 0, 2147483647);
        long long started_ms = isfinite(startv) && startv > 0 ? (long long)startv : 0;
        speaking = is_narrator_worker_alive(spid, started_ms, now_ms);
      }
      free(rr);
    }
    if (speaking) {
      snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏹\xef\xb8\x8e narrating%s%s", BLUE, ltag, R);
      snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%s⏹\xef\xb8\x8e narrating%s", BLUE, R);
      snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s⏹\xef\xb8\x8e%s", BLUE, R);
    } else if (enabled) {
      snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏵ narrator on%s%s", GREEN, ltag, R);
      snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%s⏵ narrator%s", GREEN, R);
      snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s⏵%s", GREEN, R);
    } else {
      snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏸\xef\xb8\x8e narrator off%s", DIM, R);
      snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%s⏸\xef\xb8\x8e narrator%s", DIM, R);
      snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s⏸\xef\xb8\x8e%s", DIM, R);
    }
    nw++;
  }

  double tw = 100;
  if (!json_read_num(json_get_prop(ps, pe, "terminal_width"), pe, &tw) || !isfinite(tw) || tw <= 0) {
    tw = 100;
  }
  int eff_tw = clamp_double_to_int(tw, 42, 10000);
  int cols = eff_tw - 2;
  if (cols < 40) cols = 40;

  free(installed);
  free(payload);
  free(global_raw);
  free(all_cfg_raw);

  if (nw == 0) return 0;

  int tiers[8] = {0};
  char line[4096];

  for (int pass = 0; pass <= nw * 2; pass++) {
    line[0] = '\0';
    bool first = true;
    for (int i = 0; i < nw; i++) {
      const char *part = tiers[i] == 0 ? widgets[i].full : (tiers[i] == 1 ? widgets[i].compact : widgets[i].minimal);
      if (!part[0]) continue;
      if (!first) append_str(line, sizeof(line), SEP);
      append_str(line, sizeof(line), part);
      first = false;
    }
    if (visible_width(line) <= cols || pass == nw * 2) break;
    int next_tier = (pass < nw) ? 1 : 2;
    int idx = pass % nw;
    tiers[idx] = next_tier;
  }

  if (line[0]) printf("%s\n", line);
  return 0;
}
