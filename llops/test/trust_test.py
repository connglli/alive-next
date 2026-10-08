#!/usr/bin/env python3
"""The trusted llops subcommands against alive2.

Each test asks a subcommand the kernel trusts and alive-tv the same question,
and fails where the subcommand accepts what alive2 does not prove. alive-tv
runs as the kernel runs it, and its answer is read by the kernel's own code.
Run through `make test-trust`, or directly:

    python3 llops/test/trust_test.py
"""

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


def tool(variable: str, *where: str) -> str:
  """A tool in the toolchain, unless the environment `variable` names one."""
  if os.environ.get(variable):
    return os.environ[variable]
  depman = os.path.join(ROOT, "scripts", "depman.sh")
  found = subprocess.run([depman, "toolchain"], capture_output=True, text=True, check=True)
  return os.path.join(found.stdout.strip(), *where)


ALIVE_TV = tool("ALIVE_TV", "alive2", "build", "alive-tv")
CLANG = tool("CLANG", "llvm-project", "build", "bin", "clang")

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
]
PARAM_ATTRS = ["readonly", "writeonly", "readnone", "captures(none)"]
# The sets -O3 puts on a function, with the attribute put on every pointer parameter.
SETS = [
  ("nofree memory(none)", "readnone captures(none)"),
  ("nofree memory(argmem: read)", "readonly captures(none)"),
  ("nofree memory(argmem: readwrite)", "captures(none)"),
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
  """The module clang makes of the C `source` at -O3."""
  done = subprocess.run(
    [CLANG, "-O3", "-fno-strict-aliasing", *flags, "-x", "c", "-", "-S", "-emit-llvm", "-o", "-"],
    input=source,
    capture_output=True,
    text=True,
    check=True,
  )
  return done.stdout


PARAM_CHECKED = re.compile(r" (?:readonly|writeonly|readnone|captures\(none\))(?=[ ,)])")
FN_CHECKED = re.compile(r" (?:nofree|memory\([^)]*\))(?= |})")


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
    after = compiled(source, flags)
    for module in [after, *mutants(after)]:
      if run("validate", {"module": module})["conforms"]:
        pairs.append((stripped(module), module))
  return list(dict.fromkeys(pairs))


def judged(pair: tuple[str, str]) -> tuple[str, bool]:
  """What alive2 says about a pair, and whether the pair has a loop, which
  alive2 follows for two iterations."""
  loops = run("validate", {"module": pair[1]})["cyclic"]
  return alive2(*pair, unroll=2 if loops else 0), loops


class TestRespected(unittest.TestCase):
  def assertAccepted(self, pairs: list[tuple[str, str]]):
    """Every pair `respected` accepts is one alive2 proves."""
    with ThreadPoolExecutor(os.cpu_count()) as pool:
      yes = list(pool.map(lambda pair: respected(*pair), pairs))
      accepted = [pair for pair, ok in zip(pairs, yes, strict=True) if ok]
      answers = list(pool.map(judged, accepted))
    self.assertTrue(accepted, "respected accepted no pair, so nothing was compared")
    for (_, after), (said, loops) in zip(accepted, answers, strict=True):
      with self.subTest(after=after):
        # A timeout can stop alive2 inside a loop, which shows nothing either way.
        self.assertIn(said, ("correct", "failed to prove") if loops else ("correct",))

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


if __name__ == "__main__":
  unittest.main(verbosity=2)
