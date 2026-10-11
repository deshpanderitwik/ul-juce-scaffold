# ==============================================================================
# 1. Project basics
# ==============================================================================
cmake_minimum_required(VERSION 3.22)

# Pinned so the binary's minimum macOS doesn't drift with whichever SDK
# happens to be installed. Must be set before project().
set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS version" FORCE)

project(JuceScaffold VERSION 0.1.0)

# Install the built VST3 into the user plugin folder after every build.
# Turn off (-DSCAFFOLD_COPY_PLUGIN=OFF) to build without touching the copy a
# running DAW has loaded.
option(SCAFFOLD_COPY_PLUGIN "Copy the built plugin into the system plugin folder" ON)

# Serve web/ straight from the source tree so JS edits only need the in-plugin
# reload button. Off = always use the copy bundled into the binary.
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(SCAFFOLD_WEB_DEV_DEFAULT ON)
else()
    set(SCAFFOLD_WEB_DEV_DEFAULT OFF)
endif()
option(SCAFFOLD_WEB_DEV "Serve web/ from the source tree instead of the bundled copy" ${SCAFFOLD_WEB_DEV_DEFAULT})

option(SCAFFOLD_BUILD_TESTS "Build the test executables" ON)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ==============================================================================
# 2. Fetch JUCE from GitHub
# ==============================================================================
include(FetchContent)

FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.12
    GIT_SHALLOW    ON
)

FetchContent_MakeAvailable(JUCE)

# ==============================================================================
# 3. Declare the plugin target
# ==============================================================================
juce_add_plugin(JuceScaffold
    COMPANY_NAME            "Scaffold"
    PLUGIN_MANUFACTURER_CODE Scaf
    PLUGIN_CODE              Scf1

    IS_SYNTH                 TRUE
    NEEDS_MIDI_INPUT         TRUE
    NEEDS_MIDI_OUTPUT        TRUE
    IS_MIDI_EFFECT           FALSE

    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD  ${SCAFFOLD_COPY_PLUGIN}

    FORMATS                  VST3
    PRODUCT_NAME             "JuceScaffold"
    VST3_CATEGORIES          "Instrument" "Generator"
)

# ==============================================================================
# 4. Bundle web/index.html as a binary resource
# ==============================================================================
# CONFIGURE_DEPENDS makes the build re-glob, so new .js files are picked up
# without manually re-running the configure step.
file(GLOB WEB_JS_FILES CONFIGURE_DEPENDS web/*.js)
juce_add_binary_data(WebResources
    SOURCES
        web/index.html
        ${WEB_JS_FILES}
)

# ==============================================================================
# 5. Source files
# ==============================================================================
target_sources(JuceScaffold
    PRIVATE
        src/PluginProcessor.cpp
        src/PluginEditor.cpp
        src/StepSequencer.cpp
        src/NoteScheduler.cpp
        src/Bridge.cpp
)

# Build-time settings the C++ needs as a header (the source path contains
# spaces, which is awkward to pass as a -D definition).
if(SCAFFOLD_WEB_DEV)
    set(SCAFFOLD_WEB_DEV_VALUE 1)
else()
    set(SCAFFOLD_WEB_DEV_VALUE 0)
endif()
set(SCAFFOLD_WEB_DEV_DIR "${CMAKE_CURRENT_SOURCE_DIR}/web")
configure_file(src/ScaffoldConfig.h.in ${CMAKE_CURRENT_BINARY_DIR}/generated/ScaffoldConfig.h @ONLY)
target_include_directories(JuceScaffold PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/generated)

# ==============================================================================
# 6. Link dependencies
# ==============================================================================
target_link_libraries(JuceScaffold
    PRIVATE
        WebResources
        juce::juce_audio_utils
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags
)

# ==============================================================================
# 7. Compile definitions
# ==============================================================================
target_compile_definitions(JuceScaffold
    PUBLIC
        JUCE_WEB_BROWSER=1
        JUCE_USE_CURL=0
        JUCE_VST3_CAN_REPLACE_VST2=0
        JUCE_DISPLAY_SPLASH_SCREEN=0
)

# ==============================================================================
# 8. Tests
# ==============================================================================
# tests/core   — JUCE-free sequencer/scheduler tests (also builds standalone)
# tests/plugin — bridge + headless processor tests, linked against the plugin
if(SCAFFOLD_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests/core)
    add_subdirectory(tests/plugin)
endif()
