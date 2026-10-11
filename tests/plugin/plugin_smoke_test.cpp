#include "../check.h"
#include "PluginProcessor.h"
#include "Bridge.h"

// Scaffold smoke test: proves the plugin code links into a headless test
// executable. Unit C replaces this file with the real bridge / processor suite.
TEST (plugin_scaffold_links)
{
    PluginProcessor processor;
    CHECK (processor.producesMidi());

    const auto fixtures = juce::File (SCAFFOLD_FIXTURES_DIR).getChildFile ("bridge/contract.json");
    REQUIRE (fixtures.existsAsFile());
    CHECK (juce::JSON::parse (fixtures).isObject());
}
