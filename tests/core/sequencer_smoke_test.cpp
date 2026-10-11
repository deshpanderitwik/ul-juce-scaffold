#include "../check.h"
#include "StepSequencer.h"
#include <memory>

// Scaffold smoke test: proves the target builds and links. Unit A replaces
// this file with the real sequencer suite.
TEST (sequencer_scaffold_links)
{
    auto sequence = std::make_unique<seq::Sequence>();
    sequence->numSteps = 1;
    sequence->steps[0].numNotes = 1;

    seq::StepSequencer sequencer;
    seq::EventBuffer out;
    seq::StepEventBuffer steps;
    sequencer.process ({}, sequence.get(), out, steps);

    CHECK_EQ (sequencer.sequence().numSteps, 1);
}
