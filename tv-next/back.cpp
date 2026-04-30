#include "tv-next/back.h"

#include <algorithm>
#include <set>
#include <vector>

namespace alive_tv_next {

std::optional<BackwardSlice> collectBackwardSlice(const std::string &name,
                                                  const llvm::Function &fn) {
  llvm::Instruction *root = nullptr;
  for (const llvm::BasicBlock &bb : fn)
    for (const llvm::Instruction &I : bb)
      if (I.hasName() && I.getName().str() == name)
        root = const_cast<llvm::Instruction *>(&I);
  if (!root)
    return std::nullopt;

  std::set<llvm::Instruction *> visited;
  std::set<llvm::Argument *> arg_set;
  std::vector<llvm::Instruction *> worklist = {root};

  while (!worklist.empty()) {
    llvm::Instruction *I = worklist.back();
    worklist.pop_back();
    if (!visited.insert(I).second)
      continue;
    for (llvm::Value *op : I->operands()) {
      if (auto *arg = llvm::dyn_cast<llvm::Argument>(op))
        arg_set.insert(arg);
      else if (auto *opI = llvm::dyn_cast<llvm::Instruction>(op))
        worklist.push_back(opI);
    }
  }

  BackwardSlice slice;
  for (const llvm::BasicBlock &bb : fn)
    for (const llvm::Instruction &I : bb)
      if (visited.count(const_cast<llvm::Instruction *>(&I)))
        slice.insts.push_back(const_cast<llvm::Instruction *>(&I));

  slice.arg_roots.assign(arg_set.begin(), arg_set.end());
  std::sort(slice.arg_roots.begin(), slice.arg_roots.end(),
            [](llvm::Argument *a, llvm::Argument *b) {
              return a->getArgNo() < b->getArgNo();
            });
  return slice;
}

} // namespace alive_tv_next
