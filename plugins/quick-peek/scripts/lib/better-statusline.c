/*
 * Native C11 zero-dependency accelerator for Better Antigravity statusLine (~6ms in proot, <1ms native).
 * Memory-safe UTF-8 bounds, PATH_MAX buffers, JSON escaping, and full quota-cache parity with JS.
 */
#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <dirent.h>
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

typedef struct {
  char full[768];
  char compact[512];
  char minimal[384];
} Widget;

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

static void mkdir_p(const char *dir) {
  char tmp[PATH_MAX];
  size_t len = strlen(dir);
  if (len == 0 || len >= sizeof(tmp)) return;
  memcpy(tmp, dir, len + 1);
  for (char *p = tmp + 1; *p; p++) {
    if (*p == '/') {
      *p = '\0';
      mkdir(tmp, 0755);
      *p = '/';
    }
  }
  mkdir(tmp, 0755);
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
      if (cap > 1048576) break;
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

static const char *json_get_prop(const char *obj_start, const char *obj_end, const char *key) {
  if (!obj_start || !obj_end || obj_start >= obj_end) return NULL;
  const char *p = skip_ws(obj_start, obj_end);
  if (p >= obj_end || *p != '{') return NULL;
  p++;
  size_t klen = strlen(key);
  while (p < obj_end) {
    p = skip_ws(p, obj_end);
    if (p >= obj_end || *p == '}') break;
    if (*p == ',') { p++; continue; }
    if (*p != '"') break;
    const char *ks = p + 1;
    const char *ke = skip_json_string(p, obj_end);
    size_t slen = (ke > ks) ? (size_t)(ke - 1 - ks) : 0;
    bool match = (slen == klen && memcmp(ks, key, klen) == 0);
    p = skip_ws(ke, obj_end);
    if (p >= obj_end || *p != ':') break;
    p = skip_ws(p + 1, obj_end);
    if (match) return p;
    p = skip_json_value(p, obj_end);
  }
  return NULL;
}

static bool json_obj_bounds(const char *val, const char *end, const char **out_s, const char **out_e) {
  if (!val || val >= end || *val != '{') return false;
  *out_s = val;
  *out_e = skip_json_value(val, end);
  return true;
}

static bool json_read_str(const char *val, const char *end, char *out, size_t cap) {
  if (!val || val >= end || *val != '"') return false;
  const char *p = val + 1;
  size_t o = 0;
  while (p < end && *p != '"' && o + 1 < cap) {
    if (*p == '\\' && p + 1 < end) {
      p++;
      char c = *p++;
      if (c == 'n') out[o++] = '\n';
      else if (c == 'r') out[o++] = '\r';
      else if (c == 't') out[o++] = '\t';
      else out[o++] = c;
    } else {
      out[o++] = *p++;
    }
  }
  out[o] = '\0';
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

static void format_until(double sec, char out[32]) {
  if (!isfinite(sec) || sec <= 0) { out[0] = '\0'; return; }
  long long minutes = (long long)floor(sec / 60.0 + 0.5);
  if (minutes < 1) minutes = 1;
  if (minutes < 60) { snprintf(out, 32, "%lldm", minutes); return; }
  long long hours = minutes / 60;
  if (hours < 24) { snprintf(out, 32, "%lldh %lldm", hours, minutes % 60); return; }
  snprintf(out, 32, "%lldd %lldh", hours / 24, hours % 24);
}

/* Safe UTF-8 width counter: never jumps past '\0' even on truncated sequences. */
static int visible_width(const char *s) {
  int w = 0;
  for (size_t i = 0; s[i] != '\0';) {
    unsigned char c = (unsigned char)s[i];
    if (c == 0x1b && s[i + 1] == '[') {
      i += 2;
      while (s[i] != '\0') {
        unsigned char m = (unsigned char)s[i++];
        if (m >= 0x40 && m <= 0x7e) break;
      }
      continue;
    }
    if (c == 0xef && (unsigned char)s[i + 1] == 0xb8 &&
        ((unsigned char)s[i + 2] == 0x8e || (unsigned char)s[i + 2] == 0x8f)) {
      i += 3;
      continue;
    }
    w++;
    i++;
    while (s[i] != '\0' && ((unsigned char)s[i] & 0xc0) == 0x80) i++;
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

typedef struct {
  char id[64];
  char label[24];
  double pct_used;
  double reset_sec;
  long long resets_at_ms;
  bool has_reset;
} QuotaBucket;

static void bucket_label(const char *id, double reset_sec, bool has_reset, char out[24]) {
  if (contains_icase(id, "5h") || contains_icase(id, "five_hour") || contains_icase(id, "session") ||
      (has_reset && reset_sec > 0 && reset_sec <= 21600)) {
    strcpy(out, "5h");
    return;
  }
  size_t ilen = strlen(id);
  bool ends_wk = ilen >= 2 && strncasecmp(id + ilen - 2, "wk", 2) == 0;
  if (contains_icase(id, "week") || contains_icase(id, "seven_day") || ends_wk) {
    strcpy(out, "week");
    return;
  }
  const char *s = id;
  if (strncasecmp(s, "gemini-", 7) == 0) s += 7;
  else if (strncasecmp(s, "antigravity-", 12) == 0) s += 12;
  else if (strncasecmp(s, "3p-", 3) == 0) s += 3;
  else if (strncasecmp(s, "claude-", 7) == 0) s += 7;
  else if (strncasecmp(s, "gpt-", 4) == 0) s += 4;
  snprintf(out, 24, "%.10s", s);
}

enum { KIND_GOOGLE = 0, KIND_CLAUDE = 1, KIND_GPT = 2 };

static bool is_gpt_model_active(const char *ps, const char *pe) {
  const char *mv = json_get_prop(ps, pe, "model");
  if (!mv) return false;
  char mstr[128] = "";
  if (*mv == '"') {
    json_read_str(mv, pe, mstr, sizeof(mstr));
    return contains_icase(mstr, "gpt") || contains_icase(mstr, "openai");
  }
  const char *ms, *me;
  if (json_obj_bounds(mv, pe, &ms, &me)) {
    char mid[128] = "", mdn[128] = "";
    json_read_str(json_get_prop(ms, me, "id"), me, mid, sizeof(mid));
    json_read_str(json_get_prop(ms, me, "display_name"), me, mdn, sizeof(mdn));
    return contains_icase(mid, "gpt") || contains_icase(mid, "openai") ||
           contains_icase(mdn, "gpt") || contains_icase(mdn, "openai");
  }
  return false;
}

static int resolve_bucket_kind(const char *id_or_label, bool gpt_active, const char *tp_theme) {
  if (contains_icase(id_or_label, "gpt") || contains_icase(id_or_label, "openai")) return KIND_GPT;
  if (contains_icase(id_or_label, "claude") || contains_icase(id_or_label, "anthropic")) return KIND_CLAUDE;
  if (strncasecmp(id_or_label, "3p", 2) == 0 || contains_icase(id_or_label, "3p-") || contains_icase(id_or_label, "third")) {
    if (tp_theme && strcasecmp(tp_theme, "gpt") == 0) return KIND_GPT;
    if (tp_theme && strcasecmp(tp_theme, "claude") == 0) return KIND_CLAUDE;
    return gpt_active ? KIND_GPT : KIND_CLAUDE;
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
    char id[64];
    json_read_str(p, qe, id, sizeof(id));
    p = skip_ws(skip_json_string(p, qe), qe);
    if (p >= qe || *p != ':') break;
    p = skip_ws(p + 1, qe);
    const char *es, *ee;
    if (json_obj_bounds(p, qe, &es, &ee)) {
      if (json_read_bool(json_get_prop(es, ee, "disabled"), ee) != 1) {
        double rem = 0, used = 0, rsec = 0;
        bool ok = false;
        if (json_read_num(json_get_prop(es, ee, "remaining_fraction"), ee, &rem)) {
          used = (1.0 - rem) * 100.0;
          ok = true;
        } else if (json_read_num(json_get_prop(es, ee, "used_percentage"), ee, &used)) {
          ok = true;
        }
        if (ok) {
          if (used < 0) used = 0;
          if (used > 100) used = 100;
          bool hr = json_read_num(json_get_prop(es, ee, "reset_in_seconds"), ee, &rsec);
          snprintf(out[count].id, sizeof(out[count].id), "%s", id);
          out[count].pct_used = used;
          out[count].reset_sec = hr ? rsec : 0;
          out[count].has_reset = hr;
          out[count].resets_at_ms = hr ? (now_ms + (long long)floor(rsec * 1000.0 + 0.5)) : 0;
          bucket_label(id, out[count].reset_sec, hr, out[count].label);
          count++;
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
  if (out_at && json_read_num(json_get_prop(cr, ce, "at"), ce, &atv)) *out_at = (long long)atv;
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
      if (json_read_str(json_get_prop(bs, be, "label"), be, out[nb].label, sizeof(out[nb].label)) &&
          json_read_num(json_get_prop(bs, be, "percentUsed"), be, &out[nb].pct_used)) {
        out[nb].id[0] = '\0';
        json_read_str(json_get_prop(bs, be, "id"), be, out[nb].id, sizeof(out[nb].id));
        out[nb].has_reset = json_read_num(json_get_prop(bs, be, "resetSec"), be, &out[nb].reset_sec);
        double rams = 0;
        out[nb].resets_at_ms = json_read_num(json_get_prop(bs, be, "resetsAtMs"), be, &rams) ? (long long)rams : 0;
        nb++;
      }
    }
    p = skip_json_value(p, ae);
  }
  return nb;
}

static void fmt_quota_window(const QuotaBucket *w, int kind, bool with_bar, bool with_reset, char *out, size_t cap) {
  const char *icon = (kind == KIND_CLAUDE) ? "\xe2\x9c\xbb" : ((kind == KIND_GPT) ? "\xe2\x9d\x82" : "\xe2\x9c\xa6");
  const char *icol = (kind == KIND_CLAUDE) ? CLAUDE_AMBER : ((kind == KIND_GPT) ? GPT_SILVER : AGY_BLUE);
  const char *base_bcol = (kind == KIND_CLAUDE) ? CLAUDE_AMBER : ((kind == KIND_GPT) ? GPT_SLATE : AGY_BLUE);
  int pct = (int)floor(w->pct_used + 0.5);
  double cl = w->pct_used < 0 ? 0 : (w->pct_used > 100 ? 100 : w->pct_used);
  int filled = (int)floor((cl / 100.0) * 10.0 + 0.5);
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

static bool plugin_installed_and_enabled(const char *name, char installed[][260], int n_inst, const char *g_ps, const char *g_pe) {
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
  char installed[64][260];
  int n_inst = 0;
  struct dirent *de;
  while ((de = readdir(dp)) != NULL && n_inst < 64) {
    if (de->d_name[0] == '.') continue;
    snprintf(installed[n_inst++], sizeof(installed[0]), "%s", de->d_name);
  }
  closedir(dp);
  if (n_inst == 0) return 0;

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

  Widget widgets[8];
  int nw = 0;

  /* 1. Context Meter */
  if (plugin_installed_and_enabled("context-meter", installed, n_inst, g_ps, g_pe)) {
    double warn_at = 50, danger_at = 75, win_size = 200000;
    const char *cs, *ce;
    if (ac_ps && json_obj_bounds(json_get_prop(ac_ps, ac_pe, "context-meter"), ac_pe, &cs, &ce)) {
      json_read_num(json_get_prop(cs, ce, "warnAt"), ce, &warn_at);
      json_read_num(json_get_prop(cs, ce, "dangerAt"), ce, &danger_at);
    }
    double pct = -1;
    bool is_est = false;
    if (cw_s) {
      double up = 0;
      const char *cu = json_get_prop(cw_s, cw_e, "current_usage");
      bool cu_not_null = cu && !(cw_e - cu >= 4 && memcmp(cu, "null", 4) == 0);
      if (json_read_num(json_get_prop(cw_s, cw_e, "used_percentage"), cw_e, &up) && (cu_not_null || up > 0)) {
        pct = up;
      }
      json_read_num(json_get_prop(cw_s, cw_e, "context_window_size"), cw_e, &win_size);
    }
    if (pct < 0) {
      char raw_tpath[PATH_MAX] = "", tpath[PATH_MAX + 256] = "";
      if (json_read_str(json_get_prop(ps, pe, "transcript_path"), pe, raw_tpath, sizeof(raw_tpath)) && raw_tpath[0]) {
        expand_tilde(raw_tpath, home, tpath, sizeof(tpath));
        struct stat st;
        if (stat(tpath, &st) == 0) {
          double est = floor((double)st.st_size / 4.0 + 0.5);
          pct = (est / (win_size > 0 ? win_size : 200000.0)) * 100.0;
          if (pct > 99.0) pct = 99.0;
          is_est = true;
        }
      }
    }
    if (pct >= 0) {
      int rounded = (int)floor(pct + 0.5);
      const char *pfx = is_est ? "~" : "";
      const char *col = pct >= danger_at ? RED BOLD : (pct >= warn_at ? YELLOW : DIM);
      const char *hint = pct >= danger_at ? " · new session" : (pct >= warn_at ? " · /compact" : "");
      snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%scontext %s%d%%%s%s", col, pfx, rounded, hint, R);
      snprintf(widgets[nw].compact, sizeof(widgets[nw].compact), "%sctx %s%d%%%s", col, pfx, rounded, R);
      snprintf(widgets[nw].minimal, sizeof(widgets[nw].minimal), "%s%s%d%%%s", col, pfx, rounded, R);
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
      char *tr = read_file_str(tf, 16384);
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
    char *cr = read_file_str(cpath, 16384);
    QuotaBucket cached_b[8];
    long long cached_at = 0;
    int cached_nb = cr ? read_cached_quotas(cr, cached_b, 8, &cached_at) : 0;
    free(cr);

    if (nb > 0) {
      bool should_write = (cached_nb != nb) || (now_ms - cached_at >= 30000);
      if (!should_write) {
        for (int i = 0; i < nb; i++) {
          if ((int)floor(cached_b[i].pct_used + 0.5) != (int)floor(buckets[i].pct_used + 0.5)) {
            should_write = true;
            break;
          }
        }
      }
      if (should_write) {
        mkdir_p(root_dir);
        char tmpp[PATH_MAX + 300];
        snprintf(tmpp, sizeof(tmpp), "%s.tmp-%d", cpath, (int)getpid());
        FILE *cf = fopen(tmpp, "wb");
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
          fclose(cf);
          rename(tmpp, cpath);
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
        if (json_read_num(json_get_prop(ss, se, "rotateSeconds"), se, &rs) && rs > 0) rot_sec = rs;
      }
      bool gpt_active = is_gpt_model_active(ps, pe);
      QuotaBucket chosen[8];
      int nc = 0;
      if (nb >= 2 && strcmp(disp, "both") != 0) {
        if (strcmp(disp, "session") == 0) {
          for (int i = 0; i < nb; i++) {
            if (strstr(buckets[i].label, "5h") || (buckets[i].has_reset && buckets[i].reset_sec > 0 && buckets[i].reset_sec <= 21600)) {
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
          if (idx < 0) idx = 0;
          chosen[nc++] = buckets[idx];
        }
      }
      if (nc == 0) {
        for (int i = 0; i < nb; i++) chosen[nc++] = buckets[i];
      }

      widgets[nw].full[0] = widgets[nw].compact[0] = widgets[nw].minimal[0] = '\0';
      for (int i = 0; i < nc; i++) {
        const char *bkey = chosen[i].id[0] ? chosen[i].id : chosen[i].label;
        int kind = resolve_bucket_kind(bkey, gpt_active, tp_theme);
        char pf[256], pc[128], pm[96];
        fmt_quota_window(&chosen[i], kind, true, true, pf, sizeof(pf));
        fmt_quota_window(&chosen[i], kind, false, true, pc, sizeof(pc));
        fmt_quota_window(&chosen[i], kind, false, false, pm, sizeof(pm));
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
    char *tmr = read_file_str(tmf, 65536);
    if (tmr) {
      const char *tme = tmr + strlen(tmr);
      const char *arr = json_get_prop(tmr, tme, "states");
      if (arr && *arr == '[') {
        const char *ae = skip_json_value(arr, tme), *p = arr + 1;
        int max_id = 0, cnt = 0;
        while (p < ae) {
          p = skip_ws(p, ae);
          if (p >= ae || *p == ']') break;
          if (*p == ',') { p++; continue; }
          const char *os, *oe;
          if (json_obj_bounds(p, ae, &os, &oe)) {
            double idv = 0;
            if (json_read_num(json_get_prop(os, oe, "id"), oe, &idv)) {
              if ((int)idv > max_id) max_id = (int)idv;
              cnt++;
            }
          }
          p = skip_json_value(p, ae);
        }
        if (cnt > 0) {
          double curv = max_id;
          json_read_num(json_get_prop(tmr, tme, "cursor"), tme, &curv);
          int cur = (int)curv;
          if (cur < max_id) snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏪ #%d/%d%s", YELLOW, cur, max_id, R);
          else snprintf(widgets[nw].full, sizeof(widgets[nw].full), "%s⏪ #%d%s", AGY_BLUE, cur, R);
          strcpy(widgets[nw].compact, widgets[nw].full);
          strcpy(widgets[nw].minimal, widgets[nw].full);
          nw++;
        }
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
    char *ar = read_file_str(af1, 65536);
    if (!ar) ar = read_file_str(af2, 65536);
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
          char rtxt[128] = "";
          json_read_str(json_get_prop(rs, re, "text"), re, rtxt, sizeof(rtxt));
          /* Safe UTF-8 22-codepoint slice: never steps past '\0' */
          size_t bi = 0; int cp = 0;
          while (rtxt[bi] != '\0' && cp < 22) {
            bi++;
            while (rtxt[bi] != '\0' && ((unsigned char)rtxt[bi] & 0xc0) == 0x80) bi++;
            cp++;
          }
          rtxt[bi] = '\0';
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
    char lang[16] = "";
    const char *ns, *ne;
    if (ac_ps && json_obj_bounds(json_get_prop(ac_ps, ac_pe, "narrator"), ac_pe, &ns, &ne)) {
      enabled = json_read_bool(json_get_prop(ns, ne, "enabled"), ne) == 1;
      json_read_str(json_get_prop(ns, ne, "language"), ne, lang, sizeof(lang));
    }
    for (size_t i = 0; lang[i]; i++) lang[i] = (char)toupper((unsigned char)lang[i]);
    char ltag[32] = "";
    if (lang[0]) snprintf(ltag, sizeof(ltag), " · %s", lang);

    bool speaking = false;
    char rf[PATH_MAX + 256];
    snprintf(rf, sizeof(rf), "%s/narrator-runtime.json", root_dir);
    char *rr = read_file_str(rf, 4096);
    if (rr) {
      double pidv = 0;
      if (json_read_num(json_get_prop(rr, rr + strlen(rr), "speakingPid"), rr + strlen(rr), &pidv) && pidv > 0) {
        if (kill((pid_t)pidv, 0) == 0) speaking = true;
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
  json_read_num(json_get_prop(ps, pe, "terminal_width"), pe, &tw);
  int cols = (int)tw - 2;
  if (cols < 40) cols = 40;

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
