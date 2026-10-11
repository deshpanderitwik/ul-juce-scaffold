#include "Bridge.h"

// Placeholder bodies so the scaffold links. Unit C replaces this file.
namespace bridge
{

bool parseStepSequence (const juce::var&, seq::Sequence&)            { return false; }
bool parseMidi (const juce::var&, seq::ImmediateEvent&)              { return false; }
juce::String serialiseState (const PluginState&)                     { return {}; }
bool parseState (const juce::String&, PluginState&)                  { return false; }
juce::var makeTick (const Tick&, const seq::StepEvent*, int)         { return {}; }
juce::var makeState (const std::map<juce::String, juce::String>&)    { return {}; }

} // namespace bridge
