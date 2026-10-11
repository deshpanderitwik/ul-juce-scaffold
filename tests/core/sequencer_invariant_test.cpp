#include "sequencer_support.h"

#include <cstdlib>
#include <random>

// A fuzz over everything at once: the transport starting, stopping, jumping and
// looping (both host styles), tempo changes, edits, identical resends, rate
// changes, legato, phrased notes, probabilities and big chords. Whatever
// happens, a scenario that ends with the transport stopped has every note-on
// matched by a note-off and no note-off without a note-on, and the sequencer
// never emits an offset outside its block.
//
// SEQ_INVARIANT_SEEDS sets how many scenarios run (default 300); a failure
// names the seed that reproduces it.
using namespace seqtest;

namespace
{

using Rng = std::mt19937_64;

int pickInt (Rng& rng, int lo, int hi)
{
    return std::uniform_int_distribution<int> (lo, hi) (rng);
}

double pickReal (Rng& rng, double lo, double hi)
{
    return std::uniform_real_distribution<double> (lo, hi) (rng);
}

bool chance (Rng& rng, double p)
{
    return pickReal (rng, 0.0, 1.0) < p;
}

template <typename T>
T pick (Rng& rng, std::initializer_list<T> options)
{
    return *(options.begin() + pickInt (rng, 0, static_cast<int> (options.size()) - 1));
}

seq::StepNote makeNote (Rng& rng)
{
    seq::StepNote n;
    n.note        = static_cast<uint8_t> (40 + pickInt (rng, 0, 15));   // small pool: notes overlap
    n.delay       = pick<double> (rng, { 0.0, 0.0, 0.1, 0.5, 0.9 });
    n.probability = pick<float> (rng, { 1.0f, 1.0f, 0.5f, 0.0f });
    n.velocity    = static_cast<uint8_t> (pickInt (rng, 1, 127));
    return n;
}

void fillStep (Rng& rng, seq::Step& step)
{
    step.numNotes = chance (rng, 0.04) ? seq::kMaxNotesPerStep : pickInt (rng, 0, 6);
    for (int i = 0; i < step.numNotes; ++i)
        step.notes[static_cast<size_t> (i)] = makeNote (rng);
}

void makeSequence (Rng& rng, seq::Sequence& s)
{
    s.numSteps     = chance (rng, 0.1) ? 0 : pickInt (rng, 1, chance (rng, 0.1) ? 64 : 12);
    s.stepsPerBeat = pick<double> (rng, { 0.25, 0.5, 1.0, 2.0, 3.0, 4.0, 8.0, 16.0, 64.0 });
    s.gateMs       = pickReal (rng, 10.0, 2000.0);
    s.legato       = chance (rng, 0.25);
    s.tag          = pickInt (rng, 0, 5);

    for (int i = 0; i < s.numSteps; ++i)
        fillStep (rng, s.steps[static_cast<size_t> (i)]);
}

// What the page does most: change a step or two, keep the rate and length.
void editSequence (Rng& rng, seq::Sequence& s)
{
    switch (pickInt (rng, 0, 4))
    {
        case 0:  if (s.numSteps > 0) fillStep (rng, s.steps[static_cast<size_t> (pickInt (rng, 0, s.numSteps - 1))]); break;
        case 1:  s.legato = ! s.legato; break;
        case 2:  s.tag = pickInt (rng, 0, 5); break;                        // an identical resend
        case 3:  s.gateMs = pickReal (rng, 10.0, 2000.0); break;
        default: makeSequence (rng, s); break;                              // another sequence, maybe another rate
    }
}

std::string runScenario (uint64_t seed)
{
    Rng rng (seed);

    auto host = Host();
    host.sampleRate = pick<double> (rng, { 44100.0, 48000.0, 65536.0 });
    host.bpm        = pickReal (rng, 40.0, 220.0);
    host.loopStyle  = chance (rng, 0.5) ? LoopStyle::Split : LoopStyle::Unsplit;
    host.beatPos    = pick<double> (rng, { 0.0, -2.0, pickReal (rng, 0.0, 30.0) });
    host.sequencer->setSeed (seed + 1);

    const int sizeMode = pickInt (rng, 0, 3);   // 3: any size
    auto blockSize = [&]() { return sizeMode < 3 ? (sizeMode == 0 ? 32 : (sizeMode == 1 ? 512 : 2048))
                                                 : pickInt (rng, 1, 3000); };

    seq::Sequence model;
    makeSequence (rng, model);

    bool playing = true;
    const int numBlocks = pickInt (rng, 300, 1500);

    for (int b = 0; b < numBlocks; ++b)
    {
        const int size = blockSize();
        const double seconds = size / host.sampleRate;

        const seq::Sequence* post = nullptr;

        if (b == 0 || chance (rng, std::min (0.3, seconds / 0.4)))
        {
            if (b > 0)
                editSequence (rng, model);
            post = &model;
        }

        if (chance (rng, std::min (0.2, seconds / 6.0)))
        {
            playing = ! playing;
            if (playing && chance (rng, 0.5))
                host.beatPos = pickReal (rng, -2.0, 40.0);
        }
        else if (playing && chance (rng, std::min (0.2, seconds / 8.0)))
        {
            host.beatPos = pickReal (rng, -2.0, 40.0);   // a jump, either way
        }

        if (chance (rng, std::min (0.2, seconds / 5.0)))
        {
            host.looping = chance (rng, 0.7);
            if (host.looping)
            {
                host.loopStart = pick<double> (rng, { 0.0, 1.0, 2.5, 8.0 });
                host.loopEnd   = host.loopStart + pick<double> (rng, { 0.5, 1.0, 3.75, 4.0, 16.0 });
            }
        }

        if (chance (rng, std::min (0.2, seconds / 3.0)))
            host.bpm = pickReal (rng, 40.0, 220.0);

        const size_t before = host.log.size();
        const auto events = host.run (size, playing, post);

        if (! playing)
            for (size_t i = before; i < host.log.size(); ++i)
                if (host.log[i].event.on || host.log[i].event.sampleOffset != 0)
                    return "seed " + std::to_string (seed) + ": something other than a flush while stopped";

        if (host.steps.count > seq::kMaxStepEventsPerBlock)
            return "seed " + std::to_string (seed) + ": too many step events";

        for (int i = 0; i < host.steps.count; ++i)
            if (host.steps[i].numPlayed < 0 || host.steps[i].numPlayed > seq::kMaxNotesPerStep)
                return "seed " + std::to_string (seed) + ": a step event lists too many notes";
    }

    host.run (32, false);
    host.run (32, false);

    const auto why = unbalanced (host.log);
    return why.empty() ? std::string() : "seed " + std::to_string (seed) + ": " + why;
}

}

TEST (sequencer_every_random_scenario_ends_with_every_note_released)
{
    const char* env = std::getenv ("SEQ_INVARIANT_SEEDS");
    const int count = env != nullptr ? std::max (1, std::atoi (env)) : 300;

    int reported = 0;
    for (int seed = 1; seed <= count && reported < 5; ++seed)
    {
        const auto problem = runScenario (static_cast<uint64_t> (seed));

        if (! problem.empty())
        {
            check::fail (__FILE__, __LINE__, problem);
            ++reported;
        }
    }
}
