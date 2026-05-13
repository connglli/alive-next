// tv-next-range-test — unit tests for tv-next/range.cpp
//
// Builds LLVM IR programmatically, seeds argument ranges, runs
// computeRanges, and checks the derived bounds and well-definedness
// flags. Exit 0 on all-pass, non-zero on any failure.
//
// Each test function creates its own LLVMContext / Module / Function so
// tests are fully independent. Covered cases:
//   and, or, urem, udiv, lshr, ashr, shl (+nuw/nsw),
//   add/sub/mul (+nuw/nsw), select, freeze, zext, sext, trunc,
//   cross-derivation (u→s, s→u), ConstantInt lazy synthesis,
//   multi-instruction chains, and well-definedness flag propagation.

#include "tv-next/range.h"

#include "llvm/IR/BasicBlock.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Instruction.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Type.h"
#include "llvm/Support/Casting.h"

#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

// ── harness ───────────────────────────────────────────────────────────────

static int g_pass = 0, g_fail = 0;
static std::string g_ctx;

static void begin(const char *name) { g_ctx = name; }

static void chk(bool ok, const char *expr, int line) {
  if (ok) {
    ++g_pass;
  } else {
    ++g_fail;
    std::cerr << "FAIL [" << g_ctx << ":" << line << "] " << expr << "\n";
  }
}

#define CHECK(e) chk((e), #e, __LINE__)

// ── range query helpers ───────────────────────────────────────────────────
// Avoid template-argument commas inside CHECK macros by wrapping range
// comparisons in functions. The `make_pair<T1, T2>` pattern would split
// macro args at the comma between T1 and T2.

static bool hasU(const alive_tv_next::RangeMap &m, const llvm::Value *V) {
  auto it = m.find(V);
  return it != m.end() && it->second.u.has_value();
}

// Check unsigned interval exactly: [lo, hi].
static bool uEq(const alive_tv_next::RangeMap &m, const llvm::Value *V,
                uint64_t lo, uint64_t hi) {
  auto it = m.find(V);
  if (it == m.end() || !it->second.u)
    return false;
  return it->second.u->first.getZExtValue() == lo &&
         it->second.u->second.getZExtValue() == hi;
}

// Check signed interval exactly: [lo, hi].
static bool sEq(const alive_tv_next::RangeMap &m, const llvm::Value *V,
                int64_t lo, int64_t hi) {
  auto it = m.find(V);
  if (it == m.end() || !it->second.s)
    return false;
  return it->second.s->first.getSExtValue() == lo &&
         it->second.s->second.getSExtValue() == hi;
}

static bool undefFree(const alive_tv_next::RangeMap &m, const llvm::Value *V) {
  auto it = m.find(V);
  return it != m.end() && it->second.undef_free;
}

static bool poisonFree(const alive_tv_next::RangeMap &m, const llvm::Value *V) {
  auto it = m.find(V);
  return it != m.end() && it->second.poison_free;
}

static bool inMap(const alive_tv_next::RangeMap &m, const llvm::Value *V) {
  return m.find(V) != m.end();
}

// ── seed builders ─────────────────────────────────────────────────────────

static alive_tv_next::KnownRange uSeed(unsigned bw, uint64_t lo, uint64_t hi) {
  alive_tv_next::KnownRange r;
  r.u = {llvm::APInt(bw, lo), llvm::APInt(bw, hi)};
  return r;
}

static alive_tv_next::KnownRange sSeed(unsigned bw, int64_t lo, int64_t hi) {
  alive_tv_next::KnownRange r;
  r.s = {llvm::APInt(bw, static_cast<uint64_t>(lo), /*isSigned=*/true),
         llvm::APInt(bw, static_cast<uint64_t>(hi),  /*isSigned=*/true)};
  return r;
}

// Cast a Value* returned by IRBuilder to Instruction* for computeRanges.
static llvm::Instruction *asI(llvm::Value *v) {
  return llvm::cast<llvm::Instruction>(v);
}

// ── tests ─────────────────────────────────────────────────────────────────

// and X, C (non-negative constant on RHS) → u=[0,C], crossDerive fills s=u
static void test_and_const_rhs() {
  begin("and_const_rhs");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateAnd(arg, llvm::ConstantInt::get(i32, 31), "r");

  auto map = alive_tv_next::computeRanges({asI(r)}, /*seed=*/{});
  CHECK(uEq(map, r, 0, 31));
  CHECK(sEq(map, r, 0, 31)); // crossDerive: u.hi=31 non-negative → s = u
  CHECK(!undefFree(map, r));
  CHECK(!poisonFree(map, r));
}

// and C, X (constant on LHS) — tryConst checks both orderings
static void test_and_const_lhs() {
  begin("and_const_lhs");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateAnd(llvm::ConstantInt::get(i32, 63), arg, "r");

  auto map = alive_tv_next::computeRanges({asI(r)}, /*seed=*/{});
  CHECK(uEq(map, r, 0, 63));
}

// and X, Y (both u-ranges known) → [0, min(hi_x, hi_y)]
static void test_and_both_bounded() {
  begin("and_both_bounded");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  auto *r = b.CreateAnd(x, y, "r");

  alive_tv_next::RangeMap seed;
  seed[x] = uSeed(32, 0, 100);
  seed[y] = uSeed(32, 0, 50);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 50));
}

// or X, Y: lo = max(lo_x, lo_y), hi = getLowBitsSet(max activeBits)
static void test_or_bounded() {
  begin("or_bounded");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i16 = llvm::Type::getInt16Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i16, {i16, i16}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  auto *r = b.CreateOr(x, y, "r");

  // x ∈ [0,15] (4 active bits), y ∈ [0,7] (3 active bits)
  // lo = max(0,0)=0; hi = getLowBitsSet(16, max(4,3)=4) = 0xF = 15
  alive_tv_next::RangeMap seed;
  seed[x] = uSeed(16, 0, 15);
  seed[y] = uSeed(16, 0, 7);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 15));
  CHECK(sEq(map, r, 0, 15)); // crossDerive: u.hi=15 non-negative in i16
}

// urem X, C → [0, C-1]
static void test_urem_const() {
  begin("urem_const");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateURem(arg, llvm::ConstantInt::get(i32, 100), "r");

  auto map = alive_tv_next::computeRanges({asI(r)}, /*seed=*/{});
  CHECK(uEq(map, r, 0, 99));
}

// udiv X, C with seeded X → [lo/C, hi/C]
static void test_udiv_const_seeded() {
  begin("udiv_const_seeded");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateUDiv(arg, llvm::ConstantInt::get(i32, 10), "r");

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(32, 0, 99);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 9)); // [0/10, 99/10] = [0, 9]
}

// lshr X, C with seeded X → [lo>>C, hi>>C]
static void test_lshr_const_seeded() {
  begin("lshr_const_seeded");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateLShr(arg, llvm::ConstantInt::get(i64, 2), "r");

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(64, 0, 127);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 31)); // [0>>2, 127>>2] = [0, 31]
}

// ashr X, C with seeded signed X → [lo ashr C, hi ashr C] (signed)
static void test_ashr_const_seeded() {
  begin("ashr_const_seeded");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateAShr(arg, llvm::ConstantInt::get(i32, 1), "r");

  alive_tv_next::RangeMap seed;
  seed[arg] = sSeed(32, -8, 6);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(sEq(map, r, -4, 3)); // [-8 ashr 1, 6 ashr 1] = [-4, 3]
}

// shl nuw X, C with seeded unsigned X → [lo<<C, hi<<C]
static void test_shl_nuw_seeded() {
  begin("shl_nuw_seeded");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = llvm::cast<llvm::BinaryOperator>(
      b.CreateShl(arg, llvm::ConstantInt::get(i64, 3), "r"));
  r->setHasNoUnsignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(64, 0, 10);
  auto map = alive_tv_next::computeRanges({r}, seed);
  CHECK(uEq(map, r, 0, 80)); // [0<<3, 10<<3] = [0, 80]
}

// shl nsw X, C with seeded non-negative signed X → [lo<<C, hi<<C] signed;
// crossDerive fills u = s since s.lo = 0 (non-negative)
static void test_shl_nsw_seeded() {
  begin("shl_nsw_seeded");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = llvm::cast<llvm::BinaryOperator>(
      b.CreateShl(arg, llvm::ConstantInt::get(i32, 2), "r"));
  r->setHasNoSignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[arg] = sSeed(32, 0, 7);
  auto map = alive_tv_next::computeRanges({r}, seed);
  CHECK(sEq(map, r, 0, 28)); // [0<<2, 7<<2] = [0, 28]
  CHECK(uEq(map, r, 0, 28)); // crossDerive: s.lo=0 non-negative → u = s
}

// add nuw with seeded unsigned operands → [lo_x+lo_y, hi_x+hi_y]
static void test_add_nuw() {
  begin("add_nuw");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  auto *r = llvm::cast<llvm::BinaryOperator>(b.CreateAdd(x, y, "r"));
  r->setHasNoUnsignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[x] = uSeed(32, 10, 100);
  seed[y] = uSeed(32, 5, 50);
  auto map = alive_tv_next::computeRanges({r}, seed);
  CHECK(uEq(map, r, 15, 150));
}

// add nsw with seeded signed operands → [lo_x+lo_y, hi_x+hi_y] signed
static void test_add_nsw() {
  begin("add_nsw");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  auto *r = llvm::cast<llvm::BinaryOperator>(b.CreateAdd(x, y, "r"));
  r->setHasNoSignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[x] = sSeed(32, -10, 20);
  seed[y] = sSeed(32, -5, 30);
  auto map = alive_tv_next::computeRanges({r}, seed);
  CHECK(sEq(map, r, -15, 50)); // [-10+(-5), 20+30] = [-15, 50]
}

// sub nuw: conservative upper bound [0, hi_x − lo_y]
static void test_sub_nuw() {
  begin("sub_nuw");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  auto *r = llvm::cast<llvm::BinaryOperator>(b.CreateSub(x, y, "r"));
  r->setHasNoUnsignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[x] = uSeed(32, 100, 200);
  seed[y] = uSeed(32, 10, 50);
  auto map = alive_tv_next::computeRanges({r}, seed);
  // requires hi_x >= lo_y: 200 >= 10 ✓; result = [0, hi_x − lo_y] = [0, 190]
  CHECK(uEq(map, r, 0, 190));
}

// mul nuw with seeded unsigned operands → [lo_x*lo_y, hi_x*hi_y]
static void test_mul_nuw() {
  begin("mul_nuw");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  auto *r = llvm::cast<llvm::BinaryOperator>(b.CreateMul(x, y, "r"));
  r->setHasNoUnsignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[x] = uSeed(32, 1, 10);
  seed[y] = uSeed(32, 2, 5);
  auto map = alive_tv_next::computeRanges({r}, seed);
  CHECK(uEq(map, r, 2, 50));
}

// zext i16 → i64 with seeded unsigned input
static void test_zext() {
  begin("zext");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i16 = llvm::Type::getInt16Ty(ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i16}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateZExt(arg, i64, "r");

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(16, 0, 1000);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 1000));
}

// sext i16 → i64 with seeded signed input (including negative values)
static void test_sext() {
  begin("sext");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i16 = llvm::Type::getInt16Ty(ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i16}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateSExt(arg, i64, "r");

  alive_tv_next::RangeMap seed;
  seed[arg] = sSeed(16, -50, 50);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(sEq(map, r, -50, 50));
}

// trunc i64 → i8 when the value fits (hi has ≤ 8 active bits)
static void test_trunc_safe() {
  begin("trunc_safe");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  llvm::Type *i8  = llvm::Type::getInt8Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i8, {i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateTrunc(arg, i8, "r");

  // hi=127 has 7 active bits ≤ 8 → safe
  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(64, 0, 127);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 127));
}

// trunc i64 → i8 when the high bits would be lost → no range derived
static void test_trunc_unsafe() {
  begin("trunc_unsafe");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  llvm::Type *i8  = llvm::Type::getInt8Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i8, {i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateTrunc(arg, i8, "r");

  // hi=256 has 9 active bits > 8 → transfer returns nullopt
  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(64, 0, 256);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(!inMap(map, r));
}

// select cond, X, Y → join of u-ranges across both arms
static void test_select() {
  begin("select");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i1  = llvm::Type::getInt1Ty(ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i1, i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *cond = fn->getArg(0), *tv = fn->getArg(1),
                 *fv   = fn->getArg(2);
  auto *r = b.CreateSelect(cond, tv, fv, "r");

  // tv ∈ [0,10], fv ∈ [5,20] → result ∈ [min(0,5), max(10,20)] = [0, 20]
  alive_tv_next::RangeMap seed;
  seed[tv] = uSeed(32, 0, 10);
  seed[fv] = uSeed(32, 5, 20);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 20));
}

// freeze X with bounds: inherits X's bounds and always marks both flags true
static void test_freeze_with_bounds() {
  begin("freeze_with_bounds");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateFreeze(arg, "r");

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(32, 3, 7);
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 3, 7));
  CHECK(undefFree(map, r));
  CHECK(poisonFree(map, r));
}

// freeze X with no bounds: entry in map with flags=true but no u/s
static void test_freeze_no_bounds() {
  begin("freeze_no_bounds");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  auto *r = b.CreateFreeze(arg, "r");

  auto map = alive_tv_next::computeRanges({asI(r)}, /*seed=*/{});
  CHECK(inMap(map, r));  // entry exists even without bounds
  CHECK(!hasU(map, r));
  CHECK(undefFree(map, r));
  CHECK(poisonFree(map, r));
}

// well-definedness flags propagate: undef_free+poison_free on both operands
// (ConstantInt is always well-defined) → result flags are both true
static void test_flags_propagate() {
  begin("flags_propagate");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  // and with constant 15: rangeOf gives it both flags
  auto *r = b.CreateAnd(arg, llvm::ConstantInt::get(i32, 15), "r");

  alive_tv_next::KnownRange xr = uSeed(32, 0, 100);
  xr.undef_free  = true;
  xr.poison_free = true;
  alive_tv_next::RangeMap seed;
  seed[arg] = xr;
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(undefFree(map, r));
  CHECK(poisonFree(map, r));
}

// cross-derivation u→s: u.hi non-negative → s automatically filled in
static void test_cross_u_to_s() {
  begin("cross_u_to_s");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  // urem gives u=[0,49]; hi=49 is non-negative in i32 → crossDerive fills s=u
  auto *r = b.CreateURem(arg, llvm::ConstantInt::get(i32, 50), "r");

  auto map = alive_tv_next::computeRanges({asI(r)}, /*seed=*/{});
  CHECK(uEq(map, r, 0, 49));
  CHECK(sEq(map, r, 0, 49));
}

// cross-derivation s→u: s.lo non-negative → u automatically filled in
static void test_cross_s_to_u() {
  begin("cross_s_to_u");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  // shl nsw: transfer produces s only; crossDerive fills u=s when s.lo >= 0
  auto *r = llvm::cast<llvm::BinaryOperator>(
      b.CreateShl(arg, llvm::ConstantInt::get(i32, 1), "r"));
  r->setHasNoSignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[arg] = sSeed(32, 0, 10); // lo=0 non-negative
  auto map = alive_tv_next::computeRanges({r}, seed);
  CHECK(sEq(map, r, 0, 20));
  CHECK(uEq(map, r, 0, 20)); // crossDerive: s.lo=0 → u = s
}

// ConstantInt lazy synthesis: the ConstantInt divisor `5` is not in the seed
// map; rangeOf synthesizes it on demand. Tests the synthesis path explicitly
// via `or %arg, C` where the constant contributes to the upper bound.
//   arg seeded u=[0,0] (0 active bits), C=4 (3 active bits)
//   lo = max(0, 4) = 4; hi = getLowBitsSet(32, max(0,3)=3) = 7
//   → r.u = [4, 7]
static void test_const_int_lazy_synthesis() {
  begin("const_int_lazy_synthesis");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);
  // or %arg, 4: the constant 4 is NOT in the seed; rangeOf synthesizes it.
  auto *r = b.CreateOr(arg, llvm::ConstantInt::get(i32, 4), "r");

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(32, 0, 0); // 0 active bits
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  // hi = getLowBitsSet(32, max(0,3)=3) = 7; lo = max(0,4) = 4
  CHECK(uEq(map, r, 4, 7));
}

// multi-instruction chain: two independent instructions in one pass
static void test_chain_two_instrs() {
  begin("chain_two_instrs");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i64, i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  // %amt = urem i64 %y, 8     → u=[0, 7]
  // %div = udiv i64 %x, 4     → seeded x∈[0,100]: u=[0, 25]
  auto *amt = b.CreateURem(y, llvm::ConstantInt::get(i64, 8), "amt");
  auto *div = b.CreateUDiv(x, llvm::ConstantInt::get(i64, 4), "div");

  alive_tv_next::RangeMap seed;
  seed[x] = uSeed(64, 0, 100);
  std::vector<llvm::Instruction *> seq = {asI(amt), asI(div)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(uEq(map, amt, 0, 7));
  CHECK(uEq(map, div, 0, 25));
}

// chained instructions: output of `and` feeds into a subsequent udiv.
// Verifies the map built by the first instruction is available to later ones.
static void test_chain_and_feeds_udiv() {
  begin("chain_and_feeds_udiv");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0);
  // %masked = and i64 %x, 255       → u=[0, 255]
  // %div    = udiv i64 %masked, 16  → u=[0, 255/16]=[0, 15]
  auto *masked = b.CreateAnd(x, llvm::ConstantInt::get(i64, 255), "masked");
  auto *div    = b.CreateUDiv(asI(masked),
                               llvm::ConstantInt::get(i64, 16), "div");

  std::vector<llvm::Instruction *> seq = {asI(masked), asI(div)};
  auto map = alive_tv_next::computeRanges(seq, /*seed=*/{});
  CHECK(uEq(map, masked, 0, 255));
  CHECK(uEq(map, div, 0, 15));
}

// the e4 pattern: `and %p0, 31` gives u=[0,31]; tryFreezeDropFromRange checks
// that the upper bound of the shift amount is < 64 (i64 bitwidth).
static void test_e4_and_bounds_lt_bitwidth() {
  begin("e4_and_bounds_lt_bitwidth");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *p0 = fn->getArg(0);
  // %v0 = and i64 %p0, 31 — the shift amount in e4.srctgt.ll
  auto *v0 = b.CreateAnd(p0, llvm::ConstantInt::get(i64, 31), "v0");

  auto map = alive_tv_next::computeRanges({asI(v0)}, /*seed=*/{});
  CHECK(hasU(map, v0));
  // The proposer's key check: shift amount's upper bound must be < bitwidth=64
  CHECK(map.at(v0).u->second.ult(64));
}

// ── mixed well-definedness flag tests ─────────────────────────────────────

// and(well-defined x, not-well-defined y): bounds are derived, but both flags
// come out false because one operand is not clean.
static void test_flags_mixed_and() {
  begin("flags_mixed_and");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0), *y = fn->getArg(1);
  auto *r = b.CreateAnd(x, y, "r");

  alive_tv_next::RangeMap seed;
  alive_tv_next::KnownRange xr = uSeed(32, 0, 100);
  xr.undef_free = true; xr.poison_free = true;    // x is well-defined
  alive_tv_next::KnownRange yr = uSeed(32, 0, 50);
  yr.undef_free = false; yr.poison_free = false;   // y is not
  seed[x] = xr;
  seed[y] = yr;
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  // both-bounded path: u = [0, min(100, 50)] = [0, 50]
  CHECK(uEq(map, r, 0, 50));
  // one dirty operand → result is not well-defined
  CHECK(!undefFree(map, r));
  CHECK(!poisonFree(map, r));
}

// add_nuw(freeze(x), x): freeze makes one copy clean; the raw x on the other
// side is still dirty. The result therefore has bounds but dirty flags.
static void test_flags_mixed_add() {
  begin("flags_mixed_add");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *x = fn->getArg(0);
  auto *fz  = b.CreateFreeze(x, "fz");   // u=[0,10], undef_free, poison_free
  auto *add = llvm::cast<llvm::BinaryOperator>(
      b.CreateAdd(asI(fz), x, "add"));   // lR=clean, rR=dirty → dirty result
  add->setHasNoUnsignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[x] = uSeed(32, 0, 10);            // undef_free/poison_free default false
  auto map = alive_tv_next::computeRanges({asI(fz), add}, seed);
  CHECK(uEq(map, fz, 0, 10));
  CHECK(undefFree(map, fz));
  CHECK(poisonFree(map, fz));
  // add_nuw: u = [0+0, 10+10] = [0,20]; flags: clean && dirty = dirty
  CHECK(uEq(map, add, 0, 20));
  CHECK(!undefFree(map, add));
  CHECK(!poisonFree(map, add));
}

// select(cond_unknown, well-defined-tv, well-defined-fv): both arms are clean
// but the condition has no known well-definedness — result is not poison-free.
static void test_flags_select_poison_cond() {
  begin("flags_select_poison_cond");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i1  = llvm::Type::getInt1Ty(ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i1, i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *cond = fn->getArg(0), *tv = fn->getArg(1), *fv = fn->getArg(2);
  auto *r = b.CreateSelect(cond, tv, fv, "r");

  alive_tv_next::RangeMap seed;
  alive_tv_next::KnownRange tvr = uSeed(32, 0, 10);
  tvr.undef_free = true; tvr.poison_free = true;
  alive_tv_next::KnownRange fvr = uSeed(32, 5, 20);
  fvr.undef_free = true; fvr.poison_free = true;
  seed[tv] = tvr;
  seed[fv] = fvr;
  // cond not seeded → condR = nullptr inside transfer()
  auto map = alive_tv_next::computeRanges({asI(r)}, seed);
  CHECK(uEq(map, r, 0, 20));  // join: [min(0,5), max(10,20)] = [0,20]
  // condR is nullptr → the (condR && condR->undef_free) term is false
  CHECK(!undefFree(map, r));
  CHECK(!poisonFree(map, r));
}

// Contamination chain: a dirty value poisons results it flows into;
// freeze can recover the bounds and reset flags to well-defined.
static void test_flags_contamination_chain() {
  begin("flags_contamination_chain");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *clean = fn->getArg(0), *dirty = fn->getArg(1);

  // v0 = add_nuw(clean, dirty) — contaminated by dirty
  auto *v0 = llvm::cast<llvm::BinaryOperator>(b.CreateAdd(clean, dirty, "v0"));
  v0->setHasNoUnsignedWrap(true);
  // v1 = and(clean, 15) — only uses clean + ConstantInt → stays clean
  auto *v1 = b.CreateAnd(clean, llvm::ConstantInt::get(i32, 15), "v1");
  // v2 = add_nuw(v0, v1) — v0 is contaminated → result is contaminated
  auto *v2 = llvm::cast<llvm::BinaryOperator>(b.CreateAdd(v0, asI(v1), "v2"));
  v2->setHasNoUnsignedWrap(true);
  // v3 = freeze(v2) — freeze recovers well-definedness regardless
  auto *v3 = b.CreateFreeze(v2, "v3");

  alive_tv_next::RangeMap seed;
  alive_tv_next::KnownRange cleanr = uSeed(32, 0, 15);
  cleanr.undef_free = true; cleanr.poison_free = true;
  seed[clean] = cleanr;
  seed[dirty] = uSeed(32, 0, 7);  // undef_free/poison_free=false
  std::vector<llvm::Instruction *> seq = {v0, asI(v1), v2, asI(v3)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  // v0: u=[0,22], dirty
  CHECK(uEq(map, v0, 0, 22));
  CHECK(!undefFree(map, v0));
  CHECK(!poisonFree(map, v0));
  // v1: u=[0,15], clean (tryConst; ConstantInt is always well-defined)
  CHECK(uEq(map, v1, 0, 15));
  CHECK(undefFree(map, v1));
  CHECK(poisonFree(map, v1));
  // v2: u=[0,37], contaminated by v0
  CHECK(uEq(map, v2, 0, 37));
  CHECK(!undefFree(map, v2));
  CHECK(!poisonFree(map, v2));
  // v3: freeze → u=[0,37], both flags reset to true
  CHECK(uEq(map, v3, 0, 37));
  CHECK(undefFree(map, v3));
  CHECK(poisonFree(map, v3));
}

// ── 10-instruction chain tests ────────────────────────────────────────────

// Chain 1: bitmask pipeline — and/lshr/and/urem/udiv/and/add_nuw/urem/shl_nuw/or
static void test_chain_bitmask_10() {
  begin("chain_bitmask_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);

  auto *v0 = b.CreateAnd(arg,    llvm::ConstantInt::get(i32, 255), "v0"); // u=[0,255]
  auto *v1 = b.CreateLShr(asI(v0), llvm::ConstantInt::get(i32, 4),  "v1"); // u=[0,15]
  auto *v2 = b.CreateAnd(asI(v1), llvm::ConstantInt::get(i32, 7),   "v2"); // u=[0,7]
  auto *v3 = b.CreateURem(asI(v2), llvm::ConstantInt::get(i32, 5),  "v3"); // u=[0,4]
  auto *v4 = b.CreateUDiv(asI(v0), llvm::ConstantInt::get(i32, 16), "v4"); // u=[0,15]
  auto *v5 = b.CreateAnd(asI(v4), llvm::ConstantInt::get(i32, 3),   "v5"); // u=[0,3]
  auto *v6 = llvm::cast<llvm::BinaryOperator>(                              // u=[0,7]
      b.CreateAdd(asI(v3), asI(v5), "v6"));
  v6->setHasNoUnsignedWrap(true);
  auto *v7 = b.CreateURem(v6, llvm::ConstantInt::get(i32, 4), "v7");       // u=[0,3]
  auto *v8 = llvm::cast<llvm::BinaryOperator>(                              // u=[0,12]
      b.CreateShl(asI(v7), llvm::ConstantInt::get(i32, 2), "v8"));
  v8->setHasNoUnsignedWrap(true);
  // or [0,12],[0,3]: lo=0, hi=getLowBitsSet(32, max(4,2)=4)=15
  auto *v9 = b.CreateOr(v8, asI(v5), "v9");                                // u=[0,15]

  std::vector<llvm::Instruction *> seq = {
      asI(v0), asI(v1), asI(v2), asI(v3), asI(v4),
      asI(v5), v6,      asI(v7), v8,      asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, /*seed=*/{});
  CHECK(uEq(map, v0, 0, 255));
  CHECK(uEq(map, v1, 0, 15));
  CHECK(uEq(map, v2, 0, 7));
  CHECK(uEq(map, v3, 0, 4));
  CHECK(uEq(map, v4, 0, 15));
  CHECK(uEq(map, v5, 0, 3));
  CHECK(uEq(map, v6, 0, 7));
  CHECK(uEq(map, v7, 0, 3));
  CHECK(uEq(map, v8, 0, 12));
  CHECK(uEq(map, v9, 0, 15));
}

// Chain 2: arithmetic pipeline — and/lshr/udiv/mul_nuw/add_nuw/urem/lshr/and/add_nuw/udiv
// arg seeded u=[0,127]
static void test_chain_arithmetic_10() {
  begin("chain_arithmetic_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);

  auto *v0 = b.CreateAnd(arg,    llvm::ConstantInt::get(i32, 63), "v0");   // u=[0,63]
  auto *v1 = b.CreateLShr(asI(v0), llvm::ConstantInt::get(i32, 1),  "v1"); // u=[0,31]
  auto *v2 = b.CreateUDiv(asI(v1), llvm::ConstantInt::get(i32, 3),  "v2"); // u=[0,10]
  auto *v3 = llvm::cast<llvm::BinaryOperator>(                              // u=[0,100]
      b.CreateMul(asI(v2), asI(v2), "v3"));
  v3->setHasNoUnsignedWrap(true);
  auto *v4 = llvm::cast<llvm::BinaryOperator>(                              // u=[0,163]
      b.CreateAdd(v3, asI(v0), "v4"));
  v4->setHasNoUnsignedWrap(true);
  auto *v5 = b.CreateURem(v4, llvm::ConstantInt::get(i32, 100), "v5");     // u=[0,99]
  auto *v6 = b.CreateLShr(asI(v5), llvm::ConstantInt::get(i32, 2),  "v6"); // u=[0,24]
  auto *v7 = b.CreateAnd(asI(v6), llvm::ConstantInt::get(i32, 15),  "v7"); // u=[0,15]
  auto *v8 = llvm::cast<llvm::BinaryOperator>(                              // u=[0,25]
      b.CreateAdd(asI(v7), asI(v2), "v8"));
  v8->setHasNoUnsignedWrap(true);
  auto *v9 = b.CreateUDiv(v8, llvm::ConstantInt::get(i32, 6), "v9");       // u=[0,4]

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(32, 0, 127);
  std::vector<llvm::Instruction *> seq = {
      asI(v0), asI(v1), asI(v2), v3,      v4,
      asI(v5), asI(v6), asI(v7), v8,      asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(uEq(map, v0, 0, 63));
  CHECK(uEq(map, v1, 0, 31));
  CHECK(uEq(map, v2, 0, 10));
  CHECK(uEq(map, v3, 0, 100));
  CHECK(uEq(map, v4, 0, 163));
  CHECK(uEq(map, v5, 0, 99));
  CHECK(uEq(map, v6, 0, 24));
  CHECK(uEq(map, v7, 0, 15));
  CHECK(uEq(map, v8, 0, 25));
  CHECK(uEq(map, v9, 0, 4));
}

// Chain 3: signed arithmetic — add_nsw/ashr chain with two seeded signed args
// arg0 s=[-64,64], arg1 s=[0,32]
static void test_chain_signed_10() {
  begin("chain_signed_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg0 = fn->getArg(0), *arg1 = fn->getArg(1);

  auto *v0 = llvm::cast<llvm::BinaryOperator>(                    // s=[-64,96]
      b.CreateAdd(arg0, arg1, "v0"));
  v0->setHasNoSignedWrap(true);
  auto *v1 = b.CreateAShr(v0, llvm::ConstantInt::get(i32, 2), "v1"); // s=[-16,24]
  auto *v2 = llvm::cast<llvm::BinaryOperator>(                    // s=[-16,56]
      b.CreateAdd(asI(v1), arg1, "v2"));
  v2->setHasNoSignedWrap(true);
  auto *v3 = b.CreateAShr(v2, llvm::ConstantInt::get(i32, 1), "v3"); // s=[-8,28]
  auto *v4 = llvm::cast<llvm::BinaryOperator>(                    // s=[-16,56]
      b.CreateAdd(v3, v3, "v4"));
  v4->setHasNoSignedWrap(true);
  auto *v5 = b.CreateAShr(v4, llvm::ConstantInt::get(i32, 2), "v5"); // s=[-4,14]
  auto *v6 = llvm::cast<llvm::BinaryOperator>(                    // s=[-68,78]
      b.CreateAdd(asI(v5), arg0, "v6"));
  v6->setHasNoSignedWrap(true);
  auto *v7 = b.CreateAShr(v6, llvm::ConstantInt::get(i32, 3), "v7"); // s=[-9,9]
  auto *v8 = llvm::cast<llvm::BinaryOperator>(                    // s=[-13,23]
      b.CreateAdd(asI(v7), asI(v5), "v8"));
  v8->setHasNoSignedWrap(true);
  auto *v9 = b.CreateAShr(v8, llvm::ConstantInt::get(i32, 1), "v9"); // s=[-7,11]

  alive_tv_next::RangeMap seed;
  seed[arg0] = sSeed(32, -64, 64);
  seed[arg1] = sSeed(32, 0, 32);
  std::vector<llvm::Instruction *> seq = {
      v0,      asI(v1), v2,      asI(v3), v4,
      asI(v5), v6,      asI(v7), v8,      asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(sEq(map, v0, -64, 96));
  CHECK(sEq(map, v1, -16, 24));
  CHECK(sEq(map, v2, -16, 56));
  CHECK(sEq(map, v3, -8, 28));
  CHECK(sEq(map, v4, -16, 56));
  CHECK(sEq(map, v5, -4, 14));
  CHECK(sEq(map, v6, -68, 78));
  CHECK(sEq(map, v7, -9, 9));
  CHECK(sEq(map, v8, -13, 23));
  CHECK(sEq(map, v9, -7, 11));
}

// Chain 4: freeze propagates well-definedness through a 10-instruction sequence
static void test_chain_freeze_welldef_10() {
  begin("chain_freeze_welldef_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);

  auto *v0 = b.CreateAnd(arg, llvm::ConstantInt::get(i32, 255), "v0");  // u=[0,255]
  auto *v1 = b.CreateFreeze(asI(v0), "v1");       // u=[0,255], well-def
  auto *v2 = b.CreateUDiv(asI(v1), llvm::ConstantInt::get(i32, 4), "v2");  // u=[0,63]
  auto *v3 = b.CreateAnd(asI(v2), llvm::ConstantInt::get(i32, 31), "v3");  // u=[0,31]
  auto *v4 = b.CreateLShr(asI(v3), llvm::ConstantInt::get(i32, 1), "v4"); // u=[0,15]
  auto *v5 = b.CreateFreeze(arg, "v5");            // no u, but well-def
  auto *v6 = b.CreateURem(asI(v5), llvm::ConstantInt::get(i32, 16), "v6"); // u=[0,15]
  auto *v7 = llvm::cast<llvm::BinaryOperator>(     // u=[0,30]
      b.CreateAdd(asI(v4), asI(v6), "v7"));
  v7->setHasNoUnsignedWrap(true);
  auto *v8 = b.CreateLShr(v7, llvm::ConstantInt::get(i32, 1), "v8");       // u=[0,15]
  auto *v9 = b.CreateAnd(asI(v8), llvm::ConstantInt::get(i32, 7), "v9");   // u=[0,7]

  std::vector<llvm::Instruction *> seq = {
      asI(v0), asI(v1), asI(v2), asI(v3), asI(v4),
      asI(v5), asI(v6), v7,      asI(v8), asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, /*seed=*/{});
  CHECK(uEq(map, v0, 0, 255));
  CHECK(!undefFree(map, v0));
  CHECK(!poisonFree(map, v0));
  CHECK(uEq(map, v1, 0, 255));
  CHECK(undefFree(map, v1));
  CHECK(poisonFree(map, v1));
  CHECK(uEq(map, v2, 0, 63));
  CHECK(undefFree(map, v2));
  CHECK(uEq(map, v3, 0, 31));
  CHECK(undefFree(map, v3));
  CHECK(uEq(map, v4, 0, 15));
  CHECK(undefFree(map, v4));
  CHECK(inMap(map, v5));
  CHECK(!hasU(map, v5));
  CHECK(undefFree(map, v5));
  CHECK(poisonFree(map, v5));
  CHECK(uEq(map, v6, 0, 15));
  CHECK(undefFree(map, v6));
  CHECK(uEq(map, v7, 0, 30));
  CHECK(undefFree(map, v7));
  CHECK(uEq(map, v8, 0, 15));
  CHECK(uEq(map, v9, 0, 7));
}

// Chain 5: sub_nuw/udiv/and/lshr/select/mul_nuw/udiv/add_nuw/urem/and
// arg0 u=[50,200], arg1 u=[10,40], arg2 i1 (condition)
static void test_chain_sub_select_10() {
  begin("chain_sub_select_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i1  = llvm::Type::getInt1Ty(ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32, i1}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg0 = fn->getArg(0), *arg1 = fn->getArg(1),
                 *arg2 = fn->getArg(2);

  auto *v0 = llvm::cast<llvm::BinaryOperator>(              // u=[0,190]
      b.CreateSub(arg0, arg1, "v0"));
  v0->setHasNoUnsignedWrap(true);
  auto *v1 = b.CreateUDiv(v0, llvm::ConstantInt::get(i32, 4),  "v1"); // u=[0,47]
  auto *v2 = b.CreateAnd(asI(v1), llvm::ConstantInt::get(i32, 31), "v2"); // u=[0,31]
  auto *v3 = b.CreateLShr(arg0, llvm::ConstantInt::get(i32, 3),    "v3"); // u=[6,25]
  auto *v4 = b.CreateSelect(arg2, asI(v2), asI(v3), "v4");  // u=[0,31]
  auto *v5 = llvm::cast<llvm::BinaryOperator>(              // u=[0,1240]
      b.CreateMul(asI(v4), arg1, "v5"));
  v5->setHasNoUnsignedWrap(true);
  auto *v6 = b.CreateUDiv(v5, llvm::ConstantInt::get(i32, 10),   "v6"); // u=[0,124]
  auto *v7 = llvm::cast<llvm::BinaryOperator>(              // u=[0,155]
      b.CreateAdd(asI(v6), asI(v2), "v7"));
  v7->setHasNoUnsignedWrap(true);
  auto *v8 = b.CreateURem(v7, llvm::ConstantInt::get(i32, 100), "v8"); // u=[0,99]
  auto *v9 = b.CreateAnd(asI(v8), llvm::ConstantInt::get(i32, 63), "v9"); // u=[0,63]

  alive_tv_next::RangeMap seed;
  seed[arg0] = uSeed(32, 50, 200);
  seed[arg1] = uSeed(32, 10, 40);
  std::vector<llvm::Instruction *> seq = {
      v0,      asI(v1), asI(v2), asI(v3), asI(v4),
      v5,      asI(v6), v7,      asI(v8), asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(uEq(map, v0, 0, 190));
  CHECK(uEq(map, v1, 0, 47));
  CHECK(uEq(map, v2, 0, 31));
  CHECK(uEq(map, v3, 6, 25));
  CHECK(uEq(map, v4, 0, 31));
  CHECK(uEq(map, v5, 0, 1240));
  CHECK(uEq(map, v6, 0, 124));
  CHECK(uEq(map, v7, 0, 155));
  CHECK(uEq(map, v8, 0, 99));
  CHECK(uEq(map, v9, 0, 63));
}

// Chain 6: zext from i8 inputs, build up arithmetic in i32
// arg0 i8 u=[0,100], arg1 i8 u=[0,50]
static void test_chain_zext_10() {
  begin("chain_zext_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i8  = llvm::Type::getInt8Ty(ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i8, i8}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg0 = fn->getArg(0), *arg1 = fn->getArg(1);

  auto *v0 = b.CreateZExt(arg0, i32, "v0");         // u=[0,100] in i32
  auto *v1 = b.CreateZExt(arg1, i32, "v1");         // u=[0,50]  in i32
  auto *v2 = llvm::cast<llvm::BinaryOperator>(       // u=[0,150]
      b.CreateAdd(asI(v0), asI(v1), "v2"));
  v2->setHasNoUnsignedWrap(true);
  auto *v3 = llvm::cast<llvm::BinaryOperator>(       // u=[0,5000]
      b.CreateMul(asI(v0), asI(v1), "v3"));
  v3->setHasNoUnsignedWrap(true);
  auto *v4 = b.CreateUDiv(v3, llvm::ConstantInt::get(i32, 10), "v4");  // u=[0,500]
  auto *v5 = b.CreateAnd(asI(v4), llvm::ConstantInt::get(i32, 255), "v5"); // u=[0,255]
  auto *v6 = b.CreateLShr(v2, llvm::ConstantInt::get(i32, 1), "v6");   // u=[0,75]
  auto *v7 = llvm::cast<llvm::BinaryOperator>(       // u=[0,3750]
      b.CreateMul(asI(v6), asI(v1), "v7"));
  v7->setHasNoUnsignedWrap(true);
  auto *v8 = b.CreateUDiv(v7, llvm::ConstantInt::get(i32, 100), "v8"); // u=[0,37]
  auto *v9 = llvm::cast<llvm::BinaryOperator>(       // u=[0,292]
      b.CreateAdd(asI(v8), asI(v5), "v9"));
  v9->setHasNoUnsignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[arg0] = uSeed(8, 0, 100);
  seed[arg1] = uSeed(8, 0, 50);
  std::vector<llvm::Instruction *> seq = {
      asI(v0), asI(v1), v2,      v3,      asI(v4),
      asI(v5), asI(v6), v7,      asI(v8), v9};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(uEq(map, v0, 0, 100));
  CHECK(uEq(map, v1, 0, 50));
  CHECK(uEq(map, v2, 0, 150));
  CHECK(uEq(map, v3, 0, 5000));
  CHECK(uEq(map, v4, 0, 500));
  CHECK(uEq(map, v5, 0, 255));
  CHECK(uEq(map, v6, 0, 75));
  CHECK(uEq(map, v7, 0, 3750));
  CHECK(uEq(map, v8, 0, 37));
  CHECK(uEq(map, v9, 0, 292));
}

// Chain 7: cross-derivation s→u fires at every step
// arg seeded s=[0,30]; all signed-nonneg ops → u always filled by crossDerive
static void test_chain_crossderive_10() {
  begin("chain_crossderive_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);

  auto *v0 = llvm::cast<llvm::BinaryOperator>(      // s=[0,60], u=[0,60]
      b.CreateShl(arg, llvm::ConstantInt::get(i32, 1), "v0"));
  v0->setHasNoSignedWrap(true);
  auto *v1 = llvm::cast<llvm::BinaryOperator>(      // s=[0,120], u=[0,120]
      b.CreateAdd(v0, v0, "v1"));
  v1->setHasNoSignedWrap(true);
  auto *v2 = b.CreateAShr(v1, llvm::ConstantInt::get(i32, 2), "v2"); // s=[0,30], u=[0,30]
  auto *v3 = llvm::cast<llvm::BinaryOperator>(      // s=[0,60], u=[0,60]
      b.CreateAdd(asI(v2), arg, "v3"));
  v3->setHasNoSignedWrap(true);
  auto *v4 = b.CreateAShr(v3, llvm::ConstantInt::get(i32, 1), "v4"); // s=[0,30], u=[0,30]
  auto *v5 = llvm::cast<llvm::BinaryOperator>(      // s=[0,120], u=[0,120]
      b.CreateShl(asI(v4), llvm::ConstantInt::get(i32, 2), "v5"));
  v5->setHasNoSignedWrap(true);
  auto *v6 = llvm::cast<llvm::BinaryOperator>(      // s=[0,150], u=[0,150]
      b.CreateAdd(asI(v5), asI(v2), "v6"));
  v6->setHasNoSignedWrap(true);
  auto *v7 = b.CreateAShr(v6, llvm::ConstantInt::get(i32, 3), "v7"); // s=[0,18], u=[0,18]
  auto *v8 = llvm::cast<llvm::BinaryOperator>(      // s=[0,540], u=[0,540]
      b.CreateMul(asI(v7), asI(v2), "v8"));
  v8->setHasNoSignedWrap(true);
  auto *v9 = b.CreateAShr(v8, llvm::ConstantInt::get(i32, 4), "v9"); // s=[0,33], u=[0,33]

  alive_tv_next::RangeMap seed;
  seed[arg] = sSeed(32, 0, 30);
  std::vector<llvm::Instruction *> seq = {
      v0,      v1,      asI(v2), v3,      asI(v4),
      v5,      v6,      asI(v7), v8,      asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(sEq(map, v0, 0, 60));   CHECK(uEq(map, v0, 0, 60));
  CHECK(sEq(map, v1, 0, 120));  CHECK(uEq(map, v1, 0, 120));
  CHECK(sEq(map, v2, 0, 30));   CHECK(uEq(map, v2, 0, 30));
  CHECK(sEq(map, v3, 0, 60));   CHECK(uEq(map, v3, 0, 60));
  CHECK(sEq(map, v4, 0, 30));   CHECK(uEq(map, v4, 0, 30));
  CHECK(sEq(map, v5, 0, 120));  CHECK(uEq(map, v5, 0, 120));
  CHECK(sEq(map, v6, 0, 150));  CHECK(uEq(map, v6, 0, 150));
  CHECK(sEq(map, v7, 0, 18));   CHECK(uEq(map, v7, 0, 18));
  CHECK(sEq(map, v8, 0, 540));  CHECK(uEq(map, v8, 0, 540));
  CHECK(sEq(map, v9, 0, 33));   CHECK(uEq(map, v9, 0, 33));
}

// Chain 8: or gives non-trivial lower bound when both inputs have lo > 0
// arg0 u=[8,15], arg1 u=[4,7]
static void test_chain_or_lbound_10() {
  begin("chain_or_lbound_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i32 = llvm::Type::getInt32Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i32, {i32, i32}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg0 = fn->getArg(0), *arg1 = fn->getArg(1);

  // or [8,15],[4,7]: lo=max(8,4)=8, hi=getLowBitsSet(32,4)=15 → u=[8,15]
  auto *v0 = b.CreateOr(arg0, arg1, "v0");                                 // u=[8,15]
  auto *v1 = llvm::cast<llvm::BinaryOperator>(                             // u=[16,30]
      b.CreateAdd(asI(v0), arg0, "v1"));
  v1->setHasNoUnsignedWrap(true);
  auto *v2 = b.CreateLShr(v1, llvm::ConstantInt::get(i32, 1), "v2");      // u=[8,15]
  auto *v3 = b.CreateURem(asI(v2), llvm::ConstantInt::get(i32, 10), "v3"); // u=[0,9]
  // or [8,15],[0,9]: lo=8, kx=4 (15=0b1111), ky=4 (9=0b1001); hi=15
  auto *v4 = b.CreateOr(arg0, asI(v3), "v4");                              // u=[8,15]
  auto *v5 = llvm::cast<llvm::BinaryOperator>(                             // u=[32,105]
      b.CreateMul(asI(v2), arg1, "v5"));
  v5->setHasNoUnsignedWrap(true);
  auto *v6 = b.CreateUDiv(v5, llvm::ConstantInt::get(i32, 10), "v6");     // u=[3,10]
  auto *v7 = b.CreateAnd(asI(v6), llvm::ConstantInt::get(i32, 7), "v7");  // u=[0,7]
  auto *v8 = llvm::cast<llvm::BinaryOperator>(                             // u=[4,14]
      b.CreateAdd(asI(v7), arg1, "v8"));
  v8->setHasNoUnsignedWrap(true);
  auto *v9 = b.CreateURem(v8, llvm::ConstantInt::get(i32, 8), "v9");      // u=[0,7]

  alive_tv_next::RangeMap seed;
  seed[arg0] = uSeed(32, 8, 15);
  seed[arg1] = uSeed(32, 4, 7);
  std::vector<llvm::Instruction *> seq = {
      asI(v0), v1,      asI(v2), asI(v3), asI(v4),
      v5,      asI(v6), asI(v7), v8,      asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(uEq(map, v0, 8, 15));
  CHECK(uEq(map, v1, 16, 30));
  CHECK(uEq(map, v2, 8, 15));
  CHECK(uEq(map, v3, 0, 9));
  CHECK(uEq(map, v4, 8, 15));
  CHECK(uEq(map, v5, 32, 105));
  CHECK(uEq(map, v6, 3, 10));
  CHECK(uEq(map, v7, 0, 7));
  CHECK(uEq(map, v8, 4, 14));
  CHECK(uEq(map, v9, 0, 7));
}

// Chain 9: cascading lshr halves the range, then arithmetic recombines
// arg i64 seeded u=[0,1023]
static void test_chain_lshr_reduction_10() {
  begin("chain_lshr_reduction_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg = fn->getArg(0);

  auto *v0 = b.CreateLShr(arg,    llvm::ConstantInt::get(i64, 2), "v0"); // u=[0,255]
  auto *v1 = b.CreateLShr(asI(v0), llvm::ConstantInt::get(i64, 2), "v1"); // u=[0,63]
  auto *v2 = b.CreateLShr(asI(v1), llvm::ConstantInt::get(i64, 2), "v2"); // u=[0,15]
  auto *v3 = b.CreateLShr(asI(v2), llvm::ConstantInt::get(i64, 2), "v3"); // u=[0,3]
  auto *v4 = b.CreateUDiv(arg,    llvm::ConstantInt::get(i64, 64), "v4"); // u=[0,15]
  auto *v5 = llvm::cast<llvm::BinaryOperator>(                             // u=[0,18]
      b.CreateAdd(asI(v4), asI(v3), "v5"));
  v5->setHasNoUnsignedWrap(true);
  auto *v6 = llvm::cast<llvm::BinaryOperator>(                             // u=[0,270]
      b.CreateMul(v5, asI(v2), "v6"));
  v6->setHasNoUnsignedWrap(true);
  auto *v7 = b.CreateUDiv(v6, llvm::ConstantInt::get(i64, 10), "v7");     // u=[0,27]
  auto *v8 = b.CreateAnd(asI(v7), llvm::ConstantInt::get(i64, 15), "v8"); // u=[0,15]
  // or [0,15],[0,3]: lo=0, hi=getLowBitsSet(64,4)=15
  auto *v9 = b.CreateOr(asI(v8), asI(v3), "v9");                          // u=[0,15]

  alive_tv_next::RangeMap seed;
  seed[arg] = uSeed(64, 0, 1023);
  std::vector<llvm::Instruction *> seq = {
      asI(v0), asI(v1), asI(v2), asI(v3), asI(v4),
      v5,      v6,      asI(v7), asI(v8), asI(v9)};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(uEq(map, v0, 0, 255));
  CHECK(uEq(map, v1, 0, 63));
  CHECK(uEq(map, v2, 0, 15));
  CHECK(uEq(map, v3, 0, 3));
  CHECK(uEq(map, v4, 0, 15));
  CHECK(uEq(map, v5, 0, 18));
  CHECK(uEq(map, v6, 0, 270));
  CHECK(uEq(map, v7, 0, 27));
  CHECK(uEq(map, v8, 0, 15));
  CHECK(uEq(map, v9, 0, 15));
}

// Chain 10: bitfield extraction from a 16-bit word and a byte
// arg0 i64 u=[0,65535], arg1 i64 u=[0,255]
static void test_chain_bitfield_10() {
  begin("chain_bitfield_10");
  llvm::LLVMContext ctx;
  llvm::Module M("m", ctx);
  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);
  auto *fn = llvm::Function::Create(
      llvm::FunctionType::get(i64, {i64, i64}, false),
      llvm::Function::ExternalLinkage, "f", &M);
  auto *bb = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(bb);
  llvm::Argument *arg0 = fn->getArg(0), *arg1 = fn->getArg(1);

  auto *v0 = b.CreateLShr(arg0, llvm::ConstantInt::get(i64, 8),  "v0"); // u=[0,255]
  auto *v1 = b.CreateAnd(arg0,  llvm::ConstantInt::get(i64, 255), "v1"); // u=[0,255]
  auto *v2 = b.CreateAnd(arg0,  llvm::ConstantInt::get(i64, 15),  "v2"); // u=[0,15]
  auto *v3 = b.CreateLShr(arg0, llvm::ConstantInt::get(i64, 4),  "v3"); // u=[0,4095]
  auto *v4 = b.CreateAnd(asI(v3), llvm::ConstantInt::get(i64, 15), "v4"); // u=[0,15]
  auto *v5 = llvm::cast<llvm::BinaryOperator>(                            // u=[0,30]
      b.CreateAdd(asI(v2), asI(v4), "v5"));
  v5->setHasNoUnsignedWrap(true);
  auto *v6 = llvm::cast<llvm::BinaryOperator>(                            // u=[0,7650]
      b.CreateMul(v5, arg1, "v6"));
  v6->setHasNoUnsignedWrap(true);
  auto *v7 = b.CreateLShr(v6, llvm::ConstantInt::get(i64, 2), "v7");     // u=[0,1912]
  auto *v8 = b.CreateAnd(asI(v7), llvm::ConstantInt::get(i64, 255), "v8"); // u=[0,255]
  auto *v9 = llvm::cast<llvm::BinaryOperator>(                            // u=[0,510]
      b.CreateAdd(asI(v8), asI(v0), "v9"));
  v9->setHasNoUnsignedWrap(true);

  alive_tv_next::RangeMap seed;
  seed[arg0] = uSeed(64, 0, 65535);
  seed[arg1] = uSeed(64, 0, 255);
  std::vector<llvm::Instruction *> seq = {
      asI(v0), asI(v1), asI(v2), asI(v3), asI(v4),
      v5,      v6,      asI(v7), asI(v8), v9};
  auto map = alive_tv_next::computeRanges(seq, seed);
  CHECK(uEq(map, v0, 0, 255));
  CHECK(uEq(map, v1, 0, 255));
  CHECK(uEq(map, v2, 0, 15));
  CHECK(uEq(map, v3, 0, 4095));
  CHECK(uEq(map, v4, 0, 15));
  CHECK(uEq(map, v5, 0, 30));
  CHECK(uEq(map, v6, 0, 7650));
  CHECK(uEq(map, v7, 0, 1912));
  CHECK(uEq(map, v8, 0, 255));
  CHECK(uEq(map, v9, 0, 510));
}

// ── main ──────────────────────────────────────────────────────────────────

int main() {
  test_and_const_rhs();
  test_and_const_lhs();
  test_and_both_bounded();
  test_or_bounded();
  test_urem_const();
  test_udiv_const_seeded();
  test_lshr_const_seeded();
  test_ashr_const_seeded();
  test_shl_nuw_seeded();
  test_shl_nsw_seeded();
  test_add_nuw();
  test_add_nsw();
  test_sub_nuw();
  test_mul_nuw();
  test_zext();
  test_sext();
  test_trunc_safe();
  test_trunc_unsafe();
  test_select();
  test_freeze_with_bounds();
  test_freeze_no_bounds();
  test_flags_propagate();
  test_cross_u_to_s();
  test_cross_s_to_u();
  test_const_int_lazy_synthesis();
  test_chain_two_instrs();
  test_chain_and_feeds_udiv();
  test_e4_and_bounds_lt_bitwidth();
  test_flags_mixed_and();
  test_flags_mixed_add();
  test_flags_select_poison_cond();
  test_flags_contamination_chain();
  test_chain_bitmask_10();
  test_chain_arithmetic_10();
  test_chain_signed_10();
  test_chain_freeze_welldef_10();
  test_chain_sub_select_10();
  test_chain_zext_10();
  test_chain_crossderive_10();
  test_chain_or_lbound_10();
  test_chain_lshr_reduction_10();
  test_chain_bitfield_10();

  int total = g_pass + g_fail;
  std::cout << "range-test: " << total << " checks, " << g_fail
            << " failed\n";
  return g_fail ? 1 : 0;
}
