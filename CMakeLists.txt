# ==============================================================================
# 1. Project basics
# ==============================================================================
cmake_minimum_required(VERSION 3.22)
project(JuceScaffold VERSION 0.1.0)

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
    COPY_PLUGIN_AFTER_BUILD  TRUE

    FORMATS                  VST3
    PRODUCT_NAME             "JuceScaffold"
    VST3_CATEGORIES          "Instrument" "Generator"
)

# ==============================================================================
# 4. Bundle web/index.html as a binary resource
# ==============================================================================
file(GLOB WEB_JS_FILES web/*.js)
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
)

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
