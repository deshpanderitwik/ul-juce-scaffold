# ==============================================================================
# Core tests — the JUCE-free audio-thread code (StepSequencer, NoteScheduler).
#
# Builds on its own in a few seconds, with no JUCE and no plugin:
#     cmake -S tests/core -B build-core && cmake --build build-core
#     ctest --test-dir build-core --output-on-failure
# It is also pulled into the main build by the root CMakeLists.txt.
#
# Every *.cpp in this directory is compiled into the one test executable.
# ==============================================================================
cmake_minimum_required(VERSION 3.22)
project(ScaffoldCoreTests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

file(GLOB CORE_TEST_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/*.cpp)

add_executable(ScaffoldCoreTests
    ${CORE_TEST_SOURCES}
    ${CMAKE_CURRENT_SOURCE_DIR}/../../src/StepSequencer.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../../src/NoteScheduler.cpp
)

target_include_directories(ScaffoldCoreTests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../src)
target_compile_options(ScaffoldCoreTests PRIVATE -Wall -Wextra -Wconversion)

enable_testing()
add_test(NAME core COMMAND ScaffoldCoreTests)
