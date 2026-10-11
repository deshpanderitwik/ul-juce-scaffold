# ==============================================================================
# Plugin tests — bridge parsing and the processor run headless (no host, no
# editor). Only built as part of the main build: it links the plugin's own
# compiled code, so it sees exactly what the VST3 does.
#
# Every *.cpp in this directory is compiled into the one test executable.
# ==============================================================================
file(GLOB PLUGIN_TEST_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/*.cpp)

juce_add_console_app(ScaffoldPluginTests PRODUCT_NAME "ScaffoldPluginTests")

target_sources(ScaffoldPluginTests PRIVATE ${PLUGIN_TEST_SOURCES})

# Reuse the plugin's compiled objects, and compile the tests with the same
# definitions and include paths the plugin sources were built with.
target_link_libraries(ScaffoldPluginTests PRIVATE JuceScaffold)
target_include_directories(ScaffoldPluginTests PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    $<TARGET_PROPERTY:JuceScaffold,INCLUDE_DIRECTORIES>)
target_compile_definitions(ScaffoldPluginTests PRIVATE
    $<TARGET_PROPERTY:JuceScaffold,COMPILE_DEFINITIONS>
    SCAFFOLD_FIXTURES_DIR="${CMAKE_SOURCE_DIR}/tests/fixtures")

add_test(NAME plugin COMMAND ScaffoldPluginTests)
