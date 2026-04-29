# alive-tv-next — alive-next compositional translation validator.
#
# Mirrors the build pattern of `tools/alive-tv.cpp` (see top-level
# CMakeLists.txt). At this point the source is a stub that initializes
# LLVM and Alive2/SMT and prints a "not implemented" notice; subsequent
# milestones (M1.2 onward, see ../PLAN.md) flesh it out with diff /
# cut / verify / compose.
#
# This CMakeLists is invoked by `add_subdirectory(tv-next)` in the
# top-level CMakeLists, inside the `if (BUILD_LLVM_UTILS OR BUILD_TV)`
# block — at the point where ALIVE_LIBS_LLVM, Z3_LIBRARIES,
# HIREDIS_LIBRARIES, and llvm_libs are already defined.

add_llvm_executable(alive-tv-next
  main.cpp
)

target_compile_options(alive-tv-next PRIVATE -fexceptions)

target_link_libraries(alive-tv-next PRIVATE
  ${ALIVE_LIBS_LLVM}
  ${Z3_LIBRARIES}
  ${HIREDIS_LIBRARIES}
  ${llvm_libs}
)

install(TARGETS alive-tv-next)
