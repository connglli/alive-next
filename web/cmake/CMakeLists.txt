cmake_minimum_required(VERSION 3.20)
project(alive_next_web C CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake")
endif()

if(WEB_TOOL STREQUAL "alive2")
  set(BUILD_LLVM_UTILS ON)
  set(tool_target alive-tv)
elseif(WEB_TOOL STREQUAL "llubi")
  set(tool_target llubi)
elseif(WEB_TOOL STREQUAL "llops")
  set(tool_target llops)
else()
  message(FATAL_ERROR "WEB_TOOL must be llops, alive2 or llubi")
endif()

add_subdirectory("${WEB_TOOL_SOURCE}" tool)

if(WEB_TOOL STREQUAL "llops")
  # Wrap the original dispatcher without editing the native llops sources.
  set_source_files_properties("${WEB_TOOL_SOURCE}/src/main.cpp"
    TARGET_DIRECTORY llops PROPERTIES COMPILE_DEFINITIONS "main=llopsMain")
  target_sources(llops PRIVATE llops-main.cpp)
endif()

# Export a factory so each command can create a fresh checker instance.
set_target_properties(${tool_target} PROPERTIES
  SUFFIX ".mjs"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
target_link_options(${tool_target} PRIVATE
  -fexceptions
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sINVOKE_RUN=0"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sSTACK_SIZE=8388608"
  "-sEXPORTED_RUNTIME_METHODS=['callMain','FS','HEAPU8']"
  "-sENVIRONMENT=web,worker,node")
