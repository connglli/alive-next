#!/usr/bin/env python3
"""The llops subcommands the kernel trusts, checked against alive2.

Each test asks llops and alive-tv about the same programs, and fails where
llops trusts what alive2 does not back: a pair `reshaped` or `respected`
accepts that alive2 does not prove, an attribute llops treats otherwise than
alive2 does, a fact `attrs` puts on a declaration that alive2 does not read
at a call, or a poison input `instantiate` takes where alive2 makes it UB.
alive-tv runs as the kernel runs it, and its answer is read by the kernel's
own code. Run through `make test-trust`, or directly:

    python3 llops/test/trust_test.py
"""

import functools
import importlib.util
import itertools
import os
import re
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from llops_test import ROOT, run


@functools.cache
def toolchain() -> str:
  depman = os.path.join(ROOT, "scripts", "depman.sh")
  found = subprocess.run([depman, "toolchain"], capture_output=True, text=True, check=True)
  return found.stdout.strip()


def tool(variable: str, *where: str) -> str:
  """A file in the toolchain, unless the environment `variable` names one."""
  return os.environ.get(variable) or os.path.join(toolchain(), *where)


ALIVE_TV = tool("ALIVE_TV", "alive2", "build", "alive-tv")
LLVM = os.path.join("llvm-project", "build")
CLANG = tool("CLANG", LLVM, "bin", "clang")
LLVM_AS = tool("LLVM_AS", LLVM, "bin", "llvm-as")
ATTRIBUTES = tool("ATTRIBUTES", LLVM, "include", "llvm", "IR", "Attributes.inc")

# The kernel's reading of what alive-tv printed, so that a pair counts as
# proved here exactly when the kernel would count it.
_spec = importlib.util.spec_from_file_location("check", os.path.join(ROOT, "kernel", "check.py"))
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


def alive2(src: str, tgt: str, unroll: int = 0) -> str:
  """What alive-tv says about `tgt` refining `src`, asked as the kernel asks.

  The kernel never asks about a loop. Here a loop is followed for `unroll`
  iterations, so a pair with one is proved only that far.
  """
  unrolled = [f"--src-unroll={unroll}", f"--tgt-unroll={unroll}"] if unroll else []
  with tempfile.TemporaryDirectory() as scratch:
    paths = []
    for name, text in (("src.ll", src), ("tgt.ll", tgt)):
      path = os.path.join(scratch, name)
      with open(path, "w") as out:
        out.write(text)
      paths.append(path)
    done = subprocess.run(
      [ALIVE_TV, *paths, "--smt-to=60000", "--disable-undef-input", *unrolled],
      capture_output=True,
      text=True,
      timeout=600,
    )
  return check.summary(done.stdout)


def respected(before: str, after: str) -> bool:
  """Whether `respected` accepts the pair, which has to be well formed."""
  answer = run("respected", {"before": before, "after": after})
  assert answer.get("ok"), answer
  return answer["respected"]


def reshaped(before: str, after: str) -> bool:
  """Whether `reshaped` accepts the pair, refusing a module LLVM rejects."""
  answer = run("reshaped", {"before": before, "after": after})
  assert answer.get("ok") or answer["error"]["code"] in ("parse_error", "invalid_ir"), answer
  return answer.get("reshaped", False)


def accepted(check, pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
  """The pairs `check` accepts, asked in parallel."""
  with ThreadPoolExecutor(os.cpu_count()) as pool:
    yes = list(pool.map(lambda pair: check(*pair), pairs))
  return [pair for pair, ok in zip(pairs, yes, strict=True) if ok]


@dataclass
class Seed:
  """A function @f with none of the attributes `respected` reads."""

  name: str
  params: list[str]
  ret: str
  body: str
  module: str = ""

  def program(self, fn: str = "", params: dict[int, str] | None = None) -> str:
    """The function with `fn` on itself and `params[k]` on parameter k."""
    listed = []
    for k, param in enumerate(self.params):
      ty, name = param.rsplit(" ", 1)
      listed.append(" ".join(filter(None, [ty, (params or {}).get(k), name])))
    head = f"define {self.ret} @f({', '.join(listed)})" + (f" {fn}" if fn else "")
    return f"{self.module}{head} {{\nentry:\n{self.body}\n}}\n"

  def pointers(self) -> list[int]:
    return [k for k, param in enumerate(self.params) if param.startswith("ptr ")]


# One function per thing `respected` looks at: accesses through an argument,
# through GEPs, phis and selects, to allocas and globals, calls, and the ways a
# pointer can be used as more than an address.
SEEDS = [
  Seed("load_arg", ["ptr %p"], "i32", "  %v = load i32, ptr %p, align 4\n  ret i32 %v"),
  Seed("store_arg", ["ptr %p", "i32 %x"], "void", "  store i32 %x, ptr %p, align 4\n  ret void"),
  Seed(
    "copy",
    ["ptr %p", "ptr %q"],
    "void",
    "  %v = load i32, ptr %p, align 4\n  store i32 %v, ptr %q, align 4\n  ret void",
  ),
  Seed(
    "gep_select",
    ["ptr %p", "ptr %q", "i1 %c"],
    "i32",
    "  %a = getelementptr inbounds i32, ptr %p, i64 1\n"
    "  %s = select i1 %c, ptr %a, ptr %q\n"
    "  %v = load i32, ptr %s, align 4\n"
    "  ret i32 %v",
  ),
  Seed(
    "phi_store",
    ["ptr %p", "ptr %q", "i1 %c"],
    "void",
    "  br i1 %c, label %l, label %r\n"
    "l:\n"
    "  %a = getelementptr inbounds i8, ptr %p, i64 4\n"
    "  br label %j\n"
    "r:\n"
    "  br label %j\n"
    "j:\n"
    "  %s = phi ptr [ %a, %l ], [ %q, %r ]\n"
    "  store i32 0, ptr %s, align 4\n"
    "  ret void",
  ),
  Seed(
    "phi_alloca_or_arg",
    ["ptr %p", "i1 %c"],
    "void",
    "  %a = alloca i32, align 4\n"
    "  br i1 %c, label %l, label %j\n"
    "l:\n"
    "  br label %j\n"
    "j:\n"
    "  %s = phi ptr [ %a, %entry ], [ %p, %l ]\n"
    "  store i32 0, ptr %s, align 4\n"
    "  ret void",
  ),
  Seed(
    "alloca",
    ["i32 %x"],
    "i32",
    "  %a = alloca i32, align 4\n"
    "  store i32 %x, ptr %a, align 4\n"
    "  %v = load i32, ptr %a, align 4\n"
    "  ret i32 %v",
  ),
  Seed(
    "constant_global",
    ["i32 %x"],
    "i32",
    "  %v = load i32, ptr @c, align 4\n  %s = add i32 %v, %x\n  ret i32 %s",
    "@c = constant i32 7\n\n",
  ),
  Seed(
    "global_load",
    [],
    "i32",
    "  %v = load i32, ptr @g, align 4\n  ret i32 %v",
    "@g = global i32 0\n\n",
  ),
  Seed(
    "global_store",
    ["i32 %x"],
    "void",
    "  store i32 %x, ptr @g, align 4\n  ret void",
    "@g = global i32 0\n\n",
  ),
  Seed(
    "pure_intrinsic",
    ["ptr %p", "i32 %x"],
    "i32",
    "  %v = load i32, ptr %p, align 4\n"
    "  %m = call i32 @llvm.umax.i32(i32 %v, i32 %x)\n"
    "  ret i32 %m",
    "declare i32 @llvm.umax.i32(i32, i32)\n\n",
  ),
  Seed(
    "memset",
    ["ptr %p"],
    "void",
    "  call void @llvm.memset.p0.i64(ptr %p, i8 0, i64 4, i1 false)\n  ret void",
    "declare void @llvm.memset.p0.i64(ptr, i8, i64, i1 immarg)\n\n",
  ),
  Seed(
    "memset_global",
    [],
    "void",
    "  call void @llvm.memset.p0.i64(ptr @g, i8 0, i64 4, i1 false)\n  ret void",
    "@g = global i32 0\n\ndeclare void @llvm.memset.p0.i64(ptr, i8, i64, i1 immarg)\n\n",
  ),
  Seed(
    "assume",
    ["i32 %x"],
    "i32",
    "  %c = icmp ult i32 %x, 10\n  call void @llvm.assume(i1 %c)\n  ret i32 %x",
    "declare void @llvm.assume(i1 noundef)\n\n",
  ),
  Seed(
    "unknown_call",
    ["i32 %x"],
    "i32",
    "  %v = call i32 @h(i32 %x)\n  ret i32 %v",
    "declare i32 @h(i32)\n\n",
  ),
  Seed(
    "free",
    ["ptr %p"],
    "void",
    "  call void @free(ptr %p)\n  ret void",
    "declare void @free(ptr)\n\n",
  ),
  Seed(
    "free_loaded",
    ["ptr %p"],
    "void",
    "  %q = load ptr, ptr %p, align 8\n  call void @free(ptr %q)\n  ret void",
    "declare void @free(ptr)\n\n",
  ),
  Seed(
    "ptrmask",
    ["ptr %p"],
    "i32",
    "  %m = call ptr @llvm.ptrmask.p0.i64(ptr %p, i64 -4)\n"
    "  %v = load i32, ptr %m, align 4\n"
    "  ret i32 %v",
    "declare ptr @llvm.ptrmask.p0.i64(ptr, i64)\n\n",
  ),
  Seed(
    "store_pointer",
    ["ptr %p", "ptr %q"],
    "void",
    "  store ptr %p, ptr %q, align 8\n  ret void",
  ),
  Seed(
    "pointer_through_alloca",
    ["ptr %p"],
    "i32",
    "  %a = alloca ptr, align 8\n"
    "  store ptr %p, ptr %a, align 8\n"
    "  %r = load ptr, ptr %a, align 8\n"
    "  %v = load i32, ptr %r, align 4\n"
    "  ret i32 %v",
  ),
  Seed("ptrtoint", ["ptr %p"], "i64", "  %i = ptrtoint ptr %p to i64\n  ret i64 %i"),
  Seed("compare", ["ptr %p", "ptr %q"], "i1", "  %c = icmp eq ptr %p, %q\n  ret i1 %c"),
  Seed(
    "return_pointer",
    ["ptr %p"],
    "ptr",
    "  %a = getelementptr inbounds i8, ptr %p, i64 8\n  ret ptr %a",
  ),
  Seed(
    "inttoptr",
    ["ptr %p", "i64 %x"],
    "void",
    "  %r = inttoptr i64 %x to ptr\n  store i32 0, ptr %r, align 4\n  ret void",
  ),
  Seed(
    "loaded_pointer",
    ["ptr %p"],
    "void",
    "  %q = load ptr, ptr %p, align 8\n  store i32 0, ptr %q, align 4\n  ret void",
  ),
  Seed(
    "freeze",
    ["ptr %p"],
    "i32",
    "  %f = freeze ptr %p\n  %v = load i32, ptr %f, align 4\n  ret i32 %v",
  ),
  Seed(
    "pointer_vector",
    ["<2 x ptr> %v"],
    "i32",
    "  %p = extractelement <2 x ptr> %v, i64 0\n  %x = load i32, ptr %p, align 4\n  ret i32 %x",
  ),
]

# Each function attribute `respected` reads, with the memory locations told apart.
FN_ATTRS = [
  "memory(none)",
  "memory(read)",
  "memory(write)",
  "memory(argmem: read)",
  "memory(argmem: write)",
  "memory(argmem: readwrite)",
  "memory(inaccessiblemem: readwrite)",
  "memory(readwrite, argmem: none)",
  "memory(read, argmem: readwrite)",
  "nofree",
  "willreturn",
]
PARAM_ATTRS = ["readonly", "writeonly", "readnone", "captures(none)"]
# The sets -O3 puts on a function, with the attribute put on every pointer parameter.
SETS = [
  ("nofree willreturn memory(none)", "readnone captures(none)"),
  ("nofree willreturn memory(argmem: read)", "readonly captures(none)"),
  ("nofree willreturn memory(argmem: readwrite)", "captures(none)"),
]


def cases(seed: Seed) -> list[str]:
  """The seed with each attribute alone, and with each set."""
  afters = [seed.program(fn=fn) for fn in FN_ATTRS]
  for k, attr in itertools.product(seed.pointers(), PARAM_ATTRS):
    afters.append(seed.program(params={k: attr}))
  for fn, attr in SETS:
    afters.append(seed.program(fn=fn, params=dict.fromkeys(seed.pointers(), attr)))
  return afters


# Well-known small functions, compiled at -O3 by the toolchain's clang, so
# that their attributes come from LLVM's own analysis rather than from here.
REAL = {
  "sum": "int sum(const int *a, int n) { int s = 0; for (int i = 0; i < n; i++) s += a[i]; return s; }",
  "copy": "void copy(int *d, const int *s, int n) { for (int i = 0; i < n; i++) d[i] = s[i]; }",
  "strlen": "unsigned my_strlen(const char *s) { unsigned n = 0; while (s[n]) n++; return n; }",
  "find": "int find(const int *a, int n, int x) {"
  " for (int i = 0; i < n; i++) if (a[i] == x) return i; return -1; }",
  "count": "int count(const char *s, char c) { int k = 0; for (; *s; s++) k += *s == c; return k; }",
  "reverse": "void reverse(int *a, int n) {"
  " for (int i = 0, j = n - 1; i < j; i++, j--) { int t = a[i]; a[i] = a[j]; a[j] = t; } }",
  "swap": "void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }",
  "minmax": "void minmax(const int *a, int n, int *lo, int *hi) { int l = a[0], h = a[0];"
  " for (int i = 1; i < n; i++) { if (a[i] < l) l = a[i]; if (a[i] > h) h = a[i]; }"
  " *lo = l; *hi = h; }",
  "shift": "struct point { int x, y; };"
  " void shift(struct point *p, int dx) { p->x += dx; p->y -= dx; }",
  "lookup": "static const int table[8] = {1, 2, 4, 8, 16, 32, 64, 128};"
  " int lookup(unsigned i) { return table[i & 7]; }",
  "bump": "int counter; void bump(int by) { counter += by; }",
  "store_pointer": "void store_pointer(int **pp, int *p) { *pp = p; }",
  "gcd": "unsigned gcd(unsigned a, unsigned b) {"
  " while (b) { unsigned t = a % b; a = b; b = t; } return a; }",
  "atoi": "int my_atoi(const char *s) { int n = 0, neg = 0;"
  " while (*s == ' ' || (unsigned)(*s - '\\t') < 5) s++;"
  " if (*s == '-') { neg = 1; s++; } else if (*s == '+') s++;"
  " while ((unsigned)(*s - '0') < 10) n = 10 * n - (*s++ - '0'); return neg ? n : -n; }",
  "memcmp": "int my_memcmp(const void *vl, const void *vr, unsigned long n) {"
  " const unsigned char *l = vl, *r = vr; for (; n && *l == *r; n--, l++, r++);"
  " return n ? *l - *r : 0; }",
  "adler32": "unsigned adler32(const unsigned char *buf, unsigned long len) { unsigned a = 1, b = 0;"
  " for (unsigned long i = 0; i < len; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }"
  " return (b << 16) | a; }",
  "crc32": "unsigned crc32(const unsigned char *p, unsigned long n) { unsigned c = ~0u;"
  " while (n--) { c ^= *p++; for (int k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0xEDB88320u : c >> 1; }"
  " return ~c; }",
  "bsearch": "int bsearch_int(const int *a, int n, int x) { int lo = 0, hi = n - 1;"
  " while (lo <= hi) { int mid = lo + (hi - lo) / 2;"
  " if (a[mid] < x) lo = mid + 1; else if (a[mid] > x) hi = mid - 1; else return mid; }"
  " return -1; }",
  "isort": "void isort(int *a, int n) { for (int i = 1; i < n; i++) { int v = a[i], j = i - 1;"
  " while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; } }",
  "horner": "long horner(const long *c, int n, long x) {"
  " long r = 0; for (int i = n - 1; i >= 0; i--) r = r * x + c[i]; return r; }",
  "utf8": "int utf8_encode(unsigned cp, unsigned char *out) {"
  " if (cp < 0x80) { out[0] = cp; return 1; }"
  " if (cp < 0x800) { out[0] = 0xC0 | (cp >> 6); out[1] = 0x80 | (cp & 0x3F); return 2; }"
  " out[0] = 0xE0 | (cp >> 12); out[1] = 0x80 | ((cp >> 6) & 0x3F);"
  " out[2] = 0x80 | (cp & 0x3F); return 3; }",
  "days": "int days_in_month(int m, int leap) {"
  " static const int d[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};"
  " return d[(unsigned)(m - 1) % 12] + (m == 2 && leap); }",
  "before": "int before(const int *a, const int *b) { return a < b; }",
  "advance": "const int *advance(const int *p, int n) { return p + n; }",
  "list_sum": "struct node { int v; struct node *next; };"
  " int list_sum(const struct node *p) { int s = 0; while (p) { s += p->v; p = p->next; } return s; }",
  "intersect": "struct rect { int x, y, w, h; };"
  " int intersect(const struct rect *a, const struct rect *b, struct rect *r) {"
  " int x0 = a->x > b->x ? a->x : b->x, y0 = a->y > b->y ? a->y : b->y;"
  " int x1 = a->x + a->w < b->x + b->w ? a->x + a->w : b->x + b->w;"
  " int y1 = a->y + a->h < b->y + b->h ? a->y + a->h : b->y + b->h;"
  " r->x = x0; r->y = y0; r->w = x1 - x0; r->h = y1 - y0; return r->w > 0 && r->h > 0; }",
}
# Scalar code, and code the vectorizers changed. alive2 does not read the
# type-based alias metadata clang writes, so clang writes none.
FLAGS = [["-fno-vectorize", "-fno-slp-vectorize", "-fno-unroll-loops"], []]


def compiled(source: str, flags: list[str]) -> str:
  """The module clang makes of the C `source` with `flags`."""
  done = subprocess.run(
    [CLANG, "-fno-strict-aliasing", *flags, "-x", "c", "-", "-S", "-emit-llvm", "-o", "-"],
    input=source,
    capture_output=True,
    text=True,
    check=True,
  )
  return done.stdout


PARAM_CHECKED = re.compile(r" (?:readonly|writeonly|readnone|captures\(none\))(?=[ ,)])")
FN_CHECKED = re.compile(r" (?:nofree|willreturn|memory\([^)]*\))(?= |})")


def split(define: str) -> tuple[str, list[str], str]:
  """A define line as what comes before its parameters, the parameters, and the rest."""
  start = define.index("(", define.index("@")) + 1
  params, depth, begin = [], 0, start
  for at in range(start, len(define)):
    if depth == 0 and define[at] in ",)":
      params.append(define[begin:at].strip())
      begin = at + 1
      if define[at] == ")":
        return define[:start], [param for param in params if param], define[at:]
    depth += {"(": 1, ")": -1}.get(define[at], 0)
  raise ValueError(define)


def stripped(module: str) -> str:
  """The module without the attributes `respected` reads, taken off as text so
  that what this test compares does not come from the code it tests."""
  define = re.search(r"^define .*$", module, re.M).group(0)
  head, params, rest = split(define)
  params = [PARAM_CHECKED.sub("", param) for param in params]
  module = module.replace(define, head + ", ".join(params) + FN_CHECKED.sub("", rest))
  for group in re.findall(r"#\d+", rest):
    line = re.search(rf"^attributes {group} = .*$", module, re.M).group(0)
    module = module.replace(line, FN_CHECKED.sub("", line))
  return module


def mutants(module: str) -> list[str]:
  """The module with one instruction put first in its body, for each way one
  instruction can break an attribute -O3 may have given the function."""
  _, params, _ = split(re.search(r"^define .*$", module, re.M).group(0))
  lines = []
  for p in [param.split()[-1] for param in params if param.startswith("ptr ")]:
    lines += [
      f"store i8 0, ptr {p}, align 1",
      f"%trust.read = load i8, ptr {p}, align 1",
      f"store ptr {p}, ptr @trust.sink, align 8",
    ]
  lines += [
    "store i8 0, ptr @trust.byte, align 1",
    "%trust.read = load i8, ptr @trust.byte, align 1",
    "%trust.freed = load ptr, ptr @trust.sink, align 8\n  call void @free(ptr %trust.freed)",
  ]
  body = re.search(r"^define .*\{\n(?:[\w.]+:\n)?", module, re.M).end()
  first = re.search(r"^define ", module, re.M).start()
  sinks = "@trust.sink = global ptr null\n@trust.byte = global i8 0\n\ndeclare void @free(ptr)\n\n"
  return [
    module[:first] + sinks + module[first:body] + f"  {line}\n" + module[body:] for line in lines
  ]


def real_pairs() -> list[tuple[str, str]]:
  """Each real function and its mutants, without and with their attributes,
  where the function has the program shape."""
  pairs = []
  for source, flags in itertools.product(REAL.values(), FLAGS):
    after = compiled(source, ["-O3", *flags])
    for module in [after, *mutants(after)]:
      if run("validate", {"module": module})["conforms"]:
        pairs.append((stripped(module), module))
  return list(dict.fromkeys(pairs))


def judged(pair: tuple[str, str]) -> tuple[str, bool]:
  """What alive2 says about a pair, and whether the pair has a loop, which
  alive2 follows for two iterations."""
  loops = run("validate", {"module": pair[1]})["cyclic"]
  return alive2(*pair, unroll=2 if loops else 0), loops


class Case(unittest.TestCase):
  def assertProved(self, pairs: list[tuple[str, str]]):
    """alive2 proves each pair, or leaves one that loops undecided."""
    with ThreadPoolExecutor(os.cpu_count()) as pool:
      answers = list(pool.map(judged, pairs))
    for (before, after), (said, loops) in zip(pairs, answers, strict=True):
      with self.subTest(before=before, after=after):
        # alive2 can time out or crash inside a loop, which shows nothing either way.
        self.assertIn(said, ("correct", "failed to prove", "no answer") if loops else ("correct",))


class TestRespected(Case):
  def assertAccepted(self, pairs: list[tuple[str, str]]):
    """Every pair `respected` accepts is one alive2 proves."""
    yes = accepted(respected, pairs)
    self.assertTrue(yes, "respected accepted no pair, so nothing was compared")
    self.assertProved(yes)

  def test_seeds(self):
    self.assertAccepted([(seed.program(), after) for seed in SEEDS for after in cases(seed)])

  @unittest.skipUnless(os.path.exists(CLANG), "needs the toolchain's clang")
  def test_real_functions_and_their_mutants(self):
    self.assertAccepted(real_pairs())

  def test_breaks_are_refused(self):
    # A body that breaks an attribute it is given: alive2 refutes each pair,
    # which shows the break is real, and `respected` refuses each.
    breaks = {
      "a store under memory(none)": ("store_arg", "memory(none)", {}),
      "a store under memory(argmem: read)": ("store_arg", "memory(argmem: read)", {}),
      "a store to a global under memory(argmem: readwrite)": (
        "global_store",
        "memory(argmem: readwrite)",
        {},
      ),
      "a load of a global under memory(none)": ("global_load", "memory(none)", {}),
      "a store through a loaded pointer under memory(argmem: readwrite)": (
        "loaded_pointer",
        "memory(argmem: readwrite)",
        {},
      ),
      "a write through a readonly pointer": ("store_arg", "", {0: "readonly"}),
      "a read through a writeonly pointer": ("load_arg", "", {0: "writeonly"}),
      "a read through a readnone pointer": ("load_arg", "", {0: "readnone"}),
      "a free under nofree": ("free_loaded", "nofree", {}),
      "a call that may not return under willreturn": ("unknown_call", "willreturn", {}),
      "a memset of a global under memory(argmem: readwrite)": (
        "memset_global",
        "memory(argmem: readwrite)",
        {},
      ),
      "a captures(none) pointer stored": ("store_pointer", "", {0: "captures(none)"}),
      "a captures(none) pointer returned": ("return_pointer", "", {0: "captures(none)"}),
    }
    seeds = {seed.name: seed for seed in SEEDS}
    for what, (name, fn, params) in breaks.items():
      with self.subTest(what):
        seed = seeds[name]
        pair = (seed.program(), seed.program(fn=fn, params=params))
        self.assertEqual(alive2(*pair), "incorrect")
        self.assertFalse(respected(*pair))


def canonical(module: str) -> str:
  """The module as the store keeps it."""
  return run("canon", {"module": module})["module"]


def stage_pairs() -> list[tuple[str, str]]:
  """Each step of LLVM's -O3 pipeline on each real function, from clang's -O0
  module, as the modules before and after it, canonical as the store keeps them."""
  pairs = []
  for source in REAL.values():
    start = compiled(source, ["-O0", "-Xclang", "-disable-O0-optnone"])
    stages = run("opt", {"what": "pipeline", "module": start})["stages"]
    modules = [canonical(module) for module in [start, *(stage["module"] for stage in stages)]]
    pairs += zip(modules, modules[1:], strict=False)
  return pairs


# No step above freezes. Here each iteration freezes a value that may be
# poison, so each freeze may give any value, and the loop with its branch
# inverted makes the same freezes.
FROZEN = """define i32 @f(i32 %x, i32 %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %next, %body ]
  %s = phi i32 [ 0, %entry ], [ %t, %body ]
  %done = icmp eq i32 %i, %n
  br i1 %done, label %exit, label %body

body:
  %y = add nsw i32 %x, %i
  %f = freeze i32 %y
  %t = add i32 %s, %f
  %next = add i32 %i, 1
  br label %loop

exit:
  ret i32 %s
}
"""
INVERTED = FROZEN.replace(
  "icmp eq i32 %i, %n\n  br i1 %done, label %exit, label %body",
  "icmp ne i32 %i, %n\n  br i1 %done, label %body, label %exit",
)

INVERSE = dict(eq="ne", ne="eq", slt="sge", sge="slt", sgt="sle", sle="sgt")
INVERSE |= dict(ult="uge", uge="ult", ugt="ule", ule="ugt")
SWAPPED = dict(slt="sgt", sgt="slt", sle="sge", sge="sle")
SWAPPED |= dict(ult="ugt", ugt="ult", ule="uge", uge="ule")
# One change to a line of a body, as a pattern and what replaces its first
# match, for each thing `reshaped` compares: the successors of a branch, the
# predicate of a comparison, the edges of a phi, the values an instruction uses
# and their order, its constants, flags and alignment, and a store being there.
EDITS = [
  (r"br i1 (\S+), label (%\w+), label (%\w+)", r"br i1 \1, label \3, label \2"),
  (r"icmp (samesign )?(\w+)", lambda m: f"icmp {m[1] or ''}{INVERSE.get(m[2], m[2])}"),
  (r"icmp (samesign )?(\w+)", lambda m: f"icmp {m[1] or ''}{SWAPPED.get(m[2], m[2])}"),
  (r"phi (.+?) \[ ([^,]+), (%\w+) \], \[ ([^,]+), (%\w+) \]", r"phi \1 [ \4, \3 ], [ \2, \5 ]"),
  (r"(?<=[ (])%(\d+)\b(?! =)", lambda m: f"%{int(m[1]) - 1}" if int(m[1]) else m[0]),
  (r"(= (?:sub|shl|lshr|ashr|udiv|sdiv|urem|srem|icmp)\b.* )(\S+), (\S+)$", r"\1\3, \2"),
  (r"\b(i\d+) (-?\d+)\b", lambda m: f"{m[1]} {int(m[2]) + 1}"),
  (r"= add (i\d+)", r"= add nsw \1"),
  (r"align (\d+)", lambda m: f"align {2 * int(m[1])}"),
  (r"^  store .*", ""),
]


def edited(module: str) -> list[str]:
  """The module with one line of its body changed, once for each line and each
  change that applies to it."""
  lines = module.split("\n")
  found = []
  for k, line in enumerate(lines):
    if not line.startswith("  "):
      continue
    for pattern, replacement in EDITS:
      changed = re.sub(pattern, replacement, line, count=1)
      if changed != line:
        found.append("\n".join([*lines[:k], changed, *lines[k + 1 :]]))
  return found


class TestReshaped(Case):
  @unittest.skipUnless(os.path.exists(CLANG), "needs the toolchain's clang")
  def test_pipeline_steps_and_their_mutants(self):
    # The steps are reshapings LLVM made. A mutant changes one line of a step
    # `reshaped` accepts, on either side, so most are wrong and must be refused.
    frozen = (canonical(FROZEN), canonical(INVERTED))
    steps = accepted(reshaped, [*stage_pairs(), frozen])
    self.assertIn(frozen, steps)
    mutants = [(changed, after) for before, after in steps for changed in edited(before)]
    mutants += [(before, changed) for before, after in steps for changed in edited(after)]
    self.assertProved(steps + accepted(reshaped, mutants))


# Every attribute LLVM defines is listed in its build, with the places it may
# take. One that takes an argument is written here with an example argument, or
# more where the argument decides what alive2 makes of it.
ARGUMENTS = {
  "align": ["align 4"],
  "allockind": ['allockind("alloc")'],
  "allocsize": ["allocsize(0)"],
  "captures": [
    "captures(none)",
    "captures(address)",
    "captures(provenance)",
    "captures(address, provenance)",
  ],
  "dereferenceable": ["dereferenceable(4)"],
  "dereferenceable_or_null": ["dereferenceable_or_null(4)"],
  "memory": ["memory(none)", "memory(argmem: read)"],
  "nofpclass": ["nofpclass(nan)"],
  "alignstack": ["alignstack(8)"],
  "uwtable": ["uwtable(sync)"],
  "vscale_range": ["vscale_range(1,2)"],
  "range": ["range(i32 0, 10)"],
  "initializes": ["initializes((0, 4))"],
}
# The string attributes alive2 reads, and two it does not.
STRINGS = [
  ('"denormal-fp-math"="preserve-sign,preserve-sign"', "fn"),
  ('"denormal-fp-math-f32"="preserve-sign,preserve-sign"', "fn"),
  ('"alloc-family"="malloc"', "fn"),
  ('"target-cpu"="x86-64"', "fn"),
  ('"trust"="true"', "param"),
]
PLACES = {"FnAttr": "fn", "ParamAttr": "param", "RetAttr": "ret"}


def attributes() -> list[tuple[str, str]]:
  """Each attribute LLVM defines, as IR writes it, with each place it may take."""
  with open(ATTRIBUTES) as inc:
    text = inc.read()
  names = re.findall(
    r"^ATTRIBUTE_ENUM\((\w+),(\w+)\)$", text.split("#ifdef GET_ATTR_ENUM")[0], re.M
  )
  value = dict(re.findall(r"^(\w+) = (\d+),$", text, re.M))
  properties = re.findall(r"^0((?: \| AttributeProperty::\w+)*),$", text, re.M)
  found = []
  for (name, keyword), held in zip(names, properties, strict=True):
    if int(value[name]) < int(value["FirstTypeAttr"]):
      spellings = [keyword]
    elif int(value[name]) < int(value["FirstIntAttr"]):
      spellings = [f"{keyword}(i32)"]
    else:
      spellings = ARGUMENTS[keyword]
    places = [PLACES[place] for place in re.findall(r"::(\w+Attr)\b", held) if place in PLACES]
    assert places, f"{keyword} takes no place this test knows"
    found += [(spelled, place) for spelled in spellings for place in places]
  strbool = re.findall(r"^ATTRIBUTE_STRBOOL\(\w+,([\w-]+)\)$", text, re.M)
  return found + [(f'"{keyword}"="true"', "fn") for keyword in strbool] + STRINGS


def placed(attr: str, place: str) -> list[tuple[str, str]]:
  """Small functions without and with `attr` in `place`, one for each way of
  writing them, in the order they are tried."""
  pairs = []
  for ty, value in (("ptr", "null"), ("i32", "0"), ("float", "0.0")):
    if place == "fn":
      # An integer parameter for allocsize, and the flags some attributes need beside them.
      for beside in ("", "noinline ", "unnamed_addr "):
        head = f"define {ty} @f(i64 %n) {beside}"
        body = f"{{\nentry:\n  ret {ty} {value}\n}}\n"
        pairs.append((head + body, head + f"{attr} " + body))
    elif place == "param":
      for ret, returned in ((ty, f"{ty} %x"), ("void", "void")):
        body = f") {{\nentry:\n  ret {returned}\n}}\n"
        pairs.append((f"define {ret} @f({ty} %x" + body, f"define {ret} @f({ty} {attr} %x" + body))
    else:
      body = f"@f({ty} %x) {{\nentry:\n  ret {ty} %x\n}}\n"
      pairs.append((f"define {ty} " + body, f"define {attr} {ty} " + body))
  return pairs


def well_formed(module: str) -> bool:
  """Whether LLVM's verifier accepts the module."""
  done = subprocess.run(
    [LLVM_AS, "-", "-o", os.devnull], input=module, capture_output=True, text=True
  )
  return done.returncode == 0


def printed(module: str) -> str:
  """What alive-tv prints when asked whether `module` refines itself."""
  with tempfile.TemporaryDirectory() as scratch:
    path = os.path.join(scratch, "f.ll")
    with open(path, "w") as out:
      out.write(module)
    done = subprocess.run(
      [ALIVE_TV, path, path, "--disable-undef-input"], capture_output=True, text=True, timeout=300
    )
  return done.stdout


def translated(said: str) -> str:
  """The function alive-tv checked, as it printed its own reading of it."""
  return said.split("-" * 40 + "\n")[-1].split("=>")[0]


# On an input that is not NaN, whose payload a multiplication may change, a
# multiplication by one keeps the value, a denormal included, unless the
# denormal mode flushes it. alive2 reads the mode into its floating-point
# semantics without printing it, so this pair, which it proves under the
# default mode, shows whether it reads the mode.
DENORMAL = (
  "define i32 @f(float nofpclass(nan) %x) {}{{\nentry:\n  %b = bitcast float %x to i32\n"
  "  ret i32 %b\n}}\n",
  "define i32 @f(float nofpclass(nan) %x) {}{{\nentry:\n  %y = fmul float %x, 1.0\n"
  "  %b = bitcast float %y to i32\n  ret i32 %b\n}}\n",
)


def alive2_treats(bare: str, held: str, attr: str) -> str:
  """How alive2 treats the attribute `held` has and `bare` lacks: it refuses
  the function, drops the attribute with a warning, reads it, or ignores it."""
  said = printed(held)
  if check.summary(said) != "correct":
    return "refuses"
  if "ERROR: Unsupported attribute" in said:
    return "drops"
  if translated(said) != translated(printed(bare)):
    return "reads"
  if attr.startswith('"denormal-fp-math'):
    pair = [program.format(f"{attr} ") for program in DENORMAL]
    return "reads" if alive2(*pair) == "incorrect" else "ignores"
  return "ignores"


def llops_treats(bare: str, held: str, place: str) -> str:
  """How llops treats the attribute: it refuses a program with it on a
  parameter, or it reads it or ignores it when it compares two programs."""
  if place == "param":
    diagnostics = run("validate", {"module": held})["diagnostics"]
    if any(diagnostic["code"] == "unsupported_attr" for diagnostic in diagnostics):
      return "refuses"
  return "ignores" if run("reshaped", {"before": bare, "after": held})["reshaped"] else "reads"


def treatment(attr: str, place: str) -> tuple[str, str] | None:
  """How llops and alive2 treat `attr` in `place`, or nothing when no function
  can have it there."""
  for bare, held in placed(attr, place):
    if well_formed(held):
      return llops_treats(bare, held, place), alive2_treats(bare, held, attr)
  return None


# Attributes that sit only on calls or intrinsics, never on a function checked.
NOWHERE = {("builtin", "fn"), ("immarg", "param"), ("elementtype(i32)", "param")}
# What llops does where alive2 does the same. An attribute alive2 drops with a
# warning, it ignores.
AGREED = {("refuses", "refuses"), ("reads", "reads"), ("ignores", "ignores"), ("ignores", "drops")}


class TestAttributeTable(unittest.TestCase):
  @unittest.skipUnless(os.path.exists(ATTRIBUTES), "needs the toolchain's LLVM build")
  def test_llops_treats_each_attribute_as_alive2_does(self):
    cases = attributes()
    with ThreadPoolExecutor(os.cpu_count()) as pool:
      answers = list(pool.map(lambda case: treatment(*case), cases))
    nowhere = {case for case, answer in zip(cases, answers, strict=True) if answer is None}
    self.assertEqual(nowhere, NOWHERE)
    for case, answer in zip(cases, answers, strict=True):
      if answer is not None:
        with self.subTest(attr=case[0], place=case[1]):
          self.assertIn(answer, AGREED)


# A strengthen proves a parameter fact by the step that puts it on the callee's
# declaration, which shows that every value passed keeps it only where alive2
# reads it there. alive2 lets an unknown function do anything with a poison
# argument, so it refuses a step that turns a value into poison even at a call
# it cannot otherwise see, as here: the callee returns nothing and touches no
# memory. Each fact below is one `attrs` can state, with a value that keeps it;
# the function's own argument, which may be any value or poison, breaks each
# one. A range holds of a value that may be poison, since a value it rules out
# is poison.
KEPT = [
  ({"range": {"min": 0, "max": 10}}, "i8", "urem i8 %x, 10"),
  ({"noundef": True}, "i8", "freeze i8 %x"),
  ({"nonnull": True}, "ptr", "alloca i32, align 4"),
  ({"align": 4}, "ptr", "alloca i32, align 4"),
  ({"dereferenceable": 4}, "ptr", "alloca i32, align 4"),
]


# Every function attribute `attrs` can state, which leaves a call nothing to show.
PURE = "memory(none) nounwind willreturn nosync nofree norecurse mustprogress"


def calling(ty: str, keeps: str = "") -> str:
  """A function that passes @g its argument %x, or the value `keeps` defines."""
  passed, line = ("%v", f"  %v = {keeps}\n") if keeps else ("%x", "")
  return (
    f"declare void @g({ty}) {PURE}\n\n"
    f"define void @f({ty} %x) {{\n{line}  call void @g({ty} {passed})\n  ret void\n}}\n"
  )


def declared(module: str, fact: dict) -> str:
  """The module with `fact` on the first parameter of @g's declaration."""
  answer = run("attrs", {"module": module, "fn": "g", "param": 0, "attrs": fact})
  assert answer.get("ok"), answer
  return answer["module"]


class TestDeclaredFacts(unittest.TestCase):
  def test_alive2_reads_each_fact_on_a_declaration(self):
    for fact, ty, keeps in KEPT:
      with self.subTest(fact=fact):
        broken, kept = calling(ty), calling(ty, keeps)
        self.assertEqual(alive2(broken, declared(broken, fact)), "incorrect")
        self.assertEqual(alive2(kept, declared(kept, fact)), "correct")

  def test_alive2_ignores_noalias_on_a_declaration(self):
    # Both arguments are the same pointer, and alive2 still proves the step,
    # so a noalias it proves there says nothing about the pointers passed, and
    # a strengthen refuses it.
    module = (
      "declare i8 @g(ptr, ptr)\n\n"
      "define i8 @f(ptr %x) {\n  %r = call i8 @g(ptr %x, ptr %x)\n  ret i8 %r\n}\n"
    )
    self.assertEqual(alive2(module, declared(module, {"noalias": True})), "correct")


# A counterexample's input may give a parameter poison, which `instantiate`
# puts in place of its uses. Where an attribute makes a poison argument UB in
# the src, the pair holds at that input, and putting poison in place of the
# uses would drop that UB, so `instantiate` has to refuse it. Each pair below
# differs only where %x is poison, so alive2 proves it exactly when the
# attribute makes a poison %x UB.
# How a value of each type is compared with itself: true, unless it is poison.
SELF_EQUAL = {
  "i64": "%c = icmp eq i64 %x, %x",
  "ptr": "%c = icmp eq ptr %x, %x",
  "float": "%b = bitcast float %x to i32\n  %c = icmp eq i32 %b, %b",
}


def poisoned(attr: str, place: str) -> tuple[str, str] | None:
  """A pair that differs only where %x is poison, with `attr` in `place`, or
  nothing when no program llops accepts can have it there."""
  for ty, test in SELF_EQUAL.items():
    params, fn = (f"{ty} {attr} %x", "") if place == "param" else (f"{ty} %x", f" {attr}")
    head = f"define i32 @f({params}){fn} {{\nentry:\n"
    src = head + "  ret i32 1\n}\n"
    tgt = head + f"  {test}\n  %r = select i1 %c, i32 1, i32 poison\n  ret i32 %r\n}}\n"
    if well_formed(src) and llops_treats(src, src, place) != "refuses":
      return src, tgt
  return None


def refuted_at_poison(pair: tuple[str, str]) -> bool:
  """Whether the pair, which alive2 proves, is refuted at a poison input."""
  answer = run("instantiate", {"src": pair[0], "tgt": pair[1], "args": [{"kind": "poison"}]})
  return answer.get("ok", False) and alive2(answer["src"], answer["tgt"]) == "incorrect"


class TestPoisonInput(unittest.TestCase):
  @unittest.skipUnless(os.path.exists(ATTRIBUTES), "needs the toolchain's LLVM build")
  def test_no_attribute_lets_poison_refute_what_alive2_proves(self):
    cases = [case for case in attributes() if case[1] != "ret"]
    with ThreadPoolExecutor(os.cpu_count()) as pool:
      pairs = [pair for pair in pool.map(lambda case: poisoned(*case), cases) if pair]
      said = pool.map(lambda pair: alive2(*pair), pairs)
      proved = [pair for pair, answer in zip(pairs, said, strict=True) if answer == "correct"]
      bad = pool.map(refuted_at_poison, proved)
      false = [pair[0] for pair, wrong in zip(proved, bad, strict=True) if wrong]
    # Some attribute makes a poison argument UB, so the test has something to check.
    self.assertGreater(len(proved), 0)
    self.assertEqual(false, [])


if __name__ == "__main__":
  unittest.main(verbosity=2)
