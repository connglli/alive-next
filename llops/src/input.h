// The input a counterexample names: one argument per parameter, of the kinds
// docs/llops.md lists.
#pragma once

#include "llvm/ADT/APInt.h"
#include "llvm/IR/Function.h"
#include "llvm/Support/JSON.h"

#include <cstdint>
#include <vector>

namespace llops {

/** An integer, a null pointer, a pointer to memory that holds `bytes`, or poison. */
struct Arg {
  enum class Kind { Int, Null, Bytes, Poison };
  Kind kind = Kind::Int;
  llvm::APInt value;
  std::vector<uint8_t> bytes;
  uint64_t align = 1;
};

/** The arguments `spec` names for `F`, each checked against its parameter. */
bool readArgs(const llvm::Function &F, const llvm::json::Array &spec, std::vector<Arg> &out,
              llvm::json::Object &err);

} // namespace llops
