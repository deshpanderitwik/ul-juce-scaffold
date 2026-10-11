#include "../check.h"
#include <juce_events/juce_events.h>

int main (int argc, char** argv)
{
    // The processor and juce::var/JSON code expect JUCE to be initialised.
    juce::ScopedJuceInitialiser_GUI juce;
    return check::runAll (argc, argv);
}
