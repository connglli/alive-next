cmake_minimum_required(VERSION 3.20)
project(llops CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(LLVM REQUIRED CONFIG)
# The range parameter attribute, which the strengthen flow needs, arrived in
# LLVM 19.
if(LLVM_PACKAGE_VERSION VERSION_LESS 19)
  message(FATAL_ERROR "llops needs LLVM 19 or newer, found ${LLVM_PACKAGE_VERSION}")
endif()
message(STATUS "llops: LLVM ${LLVM_PACKAGE_VERSION} at ${LLVM_DIR}")
include_directories(SYSTEM ${LLVM_INCLUDE_DIRS})
separate_arguments(LLVM_DEFINITIONS_LIST NATIVE_COMMAND "${LLVM_DEFINITIONS}")
add_definitions(${LLVM_DEFINITIONS_LIST})

set(LLOPS_SOURCES
  src/irutil.cpp
  src/validate.cpp
  src/canon.cpp
  src/edit.cpp
  src/outline.cpp
  src/harness.cpp
  src/analyze.cpp
  src/main.cpp
)

# TransformUtils provides CloneModule, the value mapper and the dead code
# helper that `erase --cascade` reuses.
llvm_map_components_to_libnames(llops_libs core support asmparser irreader
                                analysis transformutils)
add_executable(llops ${LLOPS_SOURCES})
target_compile_options(llops PRIVATE -Wall -Wextra)
target_link_libraries(llops PRIVATE ${llops_libs})
install(TARGETS llops RUNTIME DESTINATION bin)
