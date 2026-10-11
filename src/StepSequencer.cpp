#include "StepSequencer.h"

// Placeholder bodies so the scaffold links. Unit A replaces this file.
namespace seq
{

void Sequence::copyFrom (const Sequence& other) noexcept
{
    numSteps     = other.numSteps;
    stepsPerBeat = other.stepsPerBeat;
    gateMs       = other.gateMs;
    legato       = other.legato;
    tag          = other.tag;

    for (int i = 0; i < other.numSteps; ++i)
        steps[static_cast<size_t> (i)] = other.steps[static_cast<size_t> (i)];
}

StepSequencer::StepSequencer() = default;

void StepSequencer::setSeed (uint64_t) noexcept {}

void StepSequencer::process (const BlockInfo&, const Sequence* newSequence,
                             EventBuffer&, StepEventBuffer&) noexcept
{
    if (newSequence != nullptr)
        current.copyFrom (*newSequence);
}

void StepSequencer::flush (EventBuffer&, int) noexcept {}

const Sequence& StepSequencer::sequence() const noexcept { return current; }

} // namespace seq
