#include "../check.h"
#include "StepSequencer.h"
#include "legacy_reference.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <memory>
#include <random>
#include <string>
#include <vector>

// =============================================================================
// Differential test: seq::StepSequencer against legacy::LegacySequencer.
//
// Both are fed the same randomly generated host timeline and the same sequence
// edits, block by block, and must append the same MIDI events in the same
// order. Every scenario is reproducible from its seed alone.
//
// Scenarios stay inside what the two are expected to agree on: the transport
// never jumps while playing, there are no loop points, stepsPerBeat only
// changes while stopped, nothing is posted that repeats what is already
// playing, and playback never starts before beat 0. The reference
// reconciles a repeat of the current content like an edit, so it silences a
// note that rings over from the previous step and is not in this one, whereas
// the sequencer treats it as the nothing it is (sequencer_steps_test.cpp covers
// that). The reference also never fires a step at a negative index (its "no step yet" marker is -1, which
// swallows a count-in), whereas the sequencer sounds and reports those steps;
// sequencer_steps_test.cpp covers count-in.
//
// The step events cannot be compared with the reference, which has none, so
// they are checked for consistency instead: consecutive indices, the rate and
// tag in effect, and played notes that belong to the step.
//
// Three flavors of scenario:
//   Binary      probabilities are exactly 0 or 1, so no dice are rolled that matter
//   Fractional  probabilities in between; the oracle rolls the same dice as the
//               sequencer, so the rolls must happen in the same order
//   Grid        65536 Hz, tempos 60 / 120 / 240, power-of-two delays and block
//               sizes: every beat position is exact in binary, so block ends,
//               note-off beats and phrased beats coincide exactly and the
//               "<= end of block" edges get exercised
// =============================================================================
namespace
{

enum class Flavor { Binary, Fractional, Grid };

const char* name (Flavor f)
{
    return f == Flavor::Binary ? "binary" : (f == Flavor::Fractional ? "fractional" : "grid");
}

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

// The dice the oracle rolls when probabilities are fractional. This is the
// same generator seq::StepSequencer owns (splitmix64, top 53 bits), so both
// sides see the same sequence of rolls provided they roll in the same order.
struct SplitMix
{
    uint64_t state;

    double next()
    {
        state += 0x9E3779B97F4A7C15ULL;
        uint64_t z = state;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        z ^= z >> 31;
        return static_cast<double> (z >> 11) * (1.0 / 9007199254740992.0);
    }
};

// ---- scenario generation -----------------------------------------------------

double pickDelay (Rng& rng, Flavor flavor)
{
    if (flavor == Flavor::Grid)
        return pick<double> (rng, { 0.0, 0.0, 0.25, 0.5 });
    return pick<double> (rng, { 0.0, 0.1, 0.25, 0.5, 0.9 });
}

seq::StepNote makeNote (Rng& rng, Flavor flavor)
{
    seq::StepNote n;
    n.note     = static_cast<uint8_t> (48 + pickInt (rng, 0, 11));   // small pool: chords overlap
    n.delay    = pickDelay (rng, flavor);
    n.velocity = 100;

    if (flavor == Flavor::Fractional)
        n.probability = pick<float> (rng, { 0.0f, 0.25f, 0.5f, 0.75f, 1.0f, 1.0f });
    else
        n.probability = chance (rng, 0.85) ? 1.0f : 0.0f;

    return n;
}

seq::Step makeStep (Rng& rng, Flavor flavor)
{
    seq::Step step;
    step.numNotes = pickInt (rng, 0, 6);
    const bool distinct = chance (rng, 0.8);

    for (int i = 0; i < step.numNotes; ++i)
    {
        for (;;)
        {
            auto n = makeNote (rng, flavor);

            bool clash = false;
            for (int j = 0; j < i; ++j)
                clash = clash || step.notes[static_cast<size_t> (j)].note == n.note;

            if (distinct && clash)
                continue;

            step.notes[static_cast<size_t> (i)] = n;
            break;
        }
    }
    return step;
}

void fillSteps (Rng& rng, seq::Sequence& s, int from, int to, Flavor flavor)
{
    for (int i = from; i < to; ++i)
        s.steps[static_cast<size_t> (i)] = makeStep (rng, flavor);
}

double pickRate (Rng& rng, Flavor flavor)
{
    if (flavor == Flavor::Grid)
        return pick<double> (rng, { 0.25, 0.5, 1.0, 2.0, 4.0 });
    return pick<double> (rng, { 0.25, 0.5, 1.0, 2.0, 3.0, 4.0 });
}

// On the grid most gates are 2000 ms, which every grid tempo caps at exactly
// one step; the rest are ordinary.
double pickGate (Rng& rng, Flavor flavor)
{
    if (flavor == Flavor::Grid && chance (rng, 0.7))
        return 2000.0;
    return pickReal (rng, 10.0, 2000.0);
}

void makeSequence (Rng& rng, seq::Sequence& s, Flavor flavor)
{
    s.numSteps     = pickInt (rng, 1, 16);
    s.stepsPerBeat = pickRate (rng, flavor);
    s.gateMs       = pickGate (rng, flavor);
    s.legato       = chance (rng, 0.25);
    fillSteps (rng, s, 0, s.numSteps, flavor);
}

void mutateStep (Rng& rng, seq::Step& step, Flavor flavor)
{
    auto at = [&step] (int i) -> seq::StepNote& { return step.notes[static_cast<size_t> (i)]; };

    switch (pickInt (rng, 0, 4))
    {
        case 0:   // add a note
            if (step.numNotes < 6)
                at (step.numNotes++) = makeNote (rng, flavor);
            break;
        case 1:   // remove a note
            if (step.numNotes > 0)
            {
                const int victim = pickInt (rng, 0, step.numNotes - 1);
                for (int i = victim; i + 1 < step.numNotes; ++i)
                    at (i) = at (i + 1);
                --step.numNotes;
            }
            break;
        case 2:   // replace a note
            if (step.numNotes > 0)
                at (pickInt (rng, 0, step.numNotes - 1)) = makeNote (rng, flavor);
            break;
        case 3:   // move a note within the step
            if (step.numNotes > 0)
                at (pickInt (rng, 0, step.numNotes - 1)).delay = pickDelay (rng, flavor);
            break;
        default:  // reroll the whole chord
            step = makeStep (rng, flavor);
            break;
    }
}

// An edit as the UI would make it. While playing the rate is never touched.
void applyEdit (Rng& rng, seq::Sequence& s, bool playing, double beatPos, Flavor flavor)
{
    const int kinds = playing ? 11 : 15;
    const int k     = pickInt (rng, 0, kinds - 1);

    if (k < 5 && s.numSteps > 0)
    {
        // Same length and rate: the mid-step reconciliation case. Half the
        // time hit the step that is sounding right now.
        int target = pickInt (rng, 0, s.numSteps - 1);
        if (chance (rng, 0.5))
        {
            const long cur = static_cast<long> (std::floor (beatPos * s.stepsPerBeat));
            target = static_cast<int> (((cur % s.numSteps) + s.numSteps) % s.numSteps);
        }

        mutateStep (rng, s.steps[static_cast<size_t> (target)], flavor);
        if (chance (rng, 0.3))
            mutateStep (rng, s.steps[static_cast<size_t> (pickInt (rng, 0, s.numSteps - 1))], flavor);
        if (chance (rng, 0.2))
            s.gateMs = pickGate (rng, flavor);
    }
    else if (k < 7)
    {
        // Different length; surviving steps keep their notes.
        const int old = s.numSteps;
        s.numSteps = pickInt (rng, 1, 16);
        fillSteps (rng, s, std::min (old, s.numSteps), s.numSteps, flavor);
    }
    else if (k < 8)
    {
        s.numSteps = 0;   // cleared
    }
    else if (k < 10)
    {
        s.legato = ! s.legato;
    }
    else if (k < 11)
    {
        s.gateMs = pickGate (rng, flavor);
    }
    else if (k < 13)
    {
        s.stepsPerBeat = pickRate (rng, flavor);   // stopped only
    }
    else
    {
        makeSequence (rng, s, flavor);   // stopped only
    }
}

// Equal in everything the sequencer plays (the tag is not compared).
bool sameContent (const seq::Sequence& a, const seq::Sequence& b)
{
    if (a.numSteps != b.numSteps || a.stepsPerBeat != b.stepsPerBeat
        || a.gateMs != b.gateMs || a.legato != b.legato)
        return false;

    for (int i = 0; i < a.numSteps; ++i)
    {
        const auto& x = a.steps[static_cast<size_t> (i)];
        const auto& y = b.steps[static_cast<size_t> (i)];

        if (x.numNotes != y.numNotes)
            return false;

        for (int j = 0; j < x.numNotes; ++j)
        {
            const auto& m = x.notes[static_cast<size_t> (j)];
            const auto& n = y.notes[static_cast<size_t> (j)];

            if (m.delay != n.delay || m.probability != n.probability
                || m.note != n.note || m.velocity != n.velocity)
                return false;
        }
    }
    return true;
}

legacy::StepSequenceState toLegacy (const seq::Sequence& s)
{
    legacy::StepSequenceState state;
    state.subdivisionMultiplier = s.stepsPerBeat;
    state.noteDurationMs        = s.gateMs;
    state.legato                = s.legato;

    for (int i = 0; i < s.numSteps; ++i)
    {
        const auto& step = s.steps[static_cast<size_t> (i)];
        std::vector<legacy::StepNote> chord;

        for (int j = 0; j < step.numNotes; ++j)
        {
            const auto& n = step.notes[static_cast<size_t> (j)];
            chord.push_back ({ n.note, n.delay, static_cast<double> (n.probability) });
        }
        state.steps.push_back (std::move (chord));
    }
    return state;
}

// ---- comparison and reporting ------------------------------------------------

bool sameEvent (const seq::MidiEvent& a, const seq::MidiEvent& b)
{
    return a.sampleOffset == b.sampleOffset && a.note == b.note && a.velocity == b.velocity
        && a.channel == b.channel && a.on == b.on;
}

std::string describe (const seq::MidiEvent* begin, const seq::MidiEvent* end)
{
    std::string s;
    char buf[64];

    for (auto* e = begin; e != end; ++e)
    {
        std::snprintf (buf, sizeof buf, " [@%d %s n%d v%d c%d]", e->sampleOffset,
                       e->on ? "on " : "off", e->note, e->velocity, e->channel);
        s += buf;
    }
    return s.empty() ? " (none)" : s;
}

struct Stats
{
    long scenarios    = 0;
    long blocks       = 0;
    long noteOns      = 0;
    long noteOffs     = 0;
    long playingEdits = 0;
    long legatoBlocks = 0;
    long emptyBlocks  = 0;
};

// Returns what is wrong with the step events of one block, or an empty string.
// `previous` is the last step reported while the transport has been playing.
std::string checkStepEvents (const seq::StepEventBuffer& steps, const seq::Sequence& model,
                             bool playing, bool& havePrevious, int& previous)
{
    if (! playing)
    {
        if (steps.count != 0)
            return "step events while stopped";
        havePrevious = false;
        return {};
    }

    for (const auto& e : steps)
    {
        if (havePrevious && e.index != previous + 1)
            return "step " + std::to_string (e.index) + " follows " + std::to_string (previous);
        havePrevious = true;
        previous     = e.index;

        if (e.stepsPerBeat != model.stepsPerBeat)
            return "step event carries the wrong rate";
        if (e.tag != model.tag)
            return "step event carries the wrong tag";

        if (model.numSteps == 0)
        {
            if (e.numPlayed != 0)
                return "notes played by an empty sequence";
            continue;
        }

        const auto& chord = model.steps[static_cast<size_t> (((e.index % model.numSteps) + model.numSteps)
                                                              % model.numSteps)];
        if (e.numPlayed < 0 || e.numPlayed > chord.numNotes)
            return "more notes played than the step holds";

        for (int i = 0; i < e.numPlayed; ++i)
        {
            bool found = false;
            for (int j = 0; j < chord.numNotes; ++j)
                found = found || chord.notes[static_cast<size_t> (j)].note == e.played[static_cast<size_t> (i)];
            if (! found)
                return "played a note that is not in the step";
        }
    }
    return {};
}

// Runs one scenario. Returns an empty string when the two sequencers agree on
// every block, otherwise a report that names the seed and the first block that
// differs.
std::string runScenario (uint64_t seed, Flavor flavor, Stats& stats)
{
    Rng rng (seed);

    const bool   grid       = flavor == Flavor::Grid;
    const double sampleRate = grid ? 65536.0 : pick<double> (rng, { 44100.0, 48000.0 });
    const int    sizeMode   = pickInt (rng, 0, grid ? 3 : 4);   // 4 = size varies per block
    const int    sizes[]    = { 32, 64, 512, 2048 };
    auto blockSize = [&]() { return sizeMode < 4 ? sizes[sizeMode] : pickInt (rng, 1, 2048); };

    // 10-30 seconds of audio, but never fewer than 200 blocks and never more
    // than 16000 (so the tiniest blocks cover less time).
    const double seconds   = pickReal (rng, 10.0, 30.0);
    const int    avgSize   = sizeMode < 4 ? sizes[sizeMode] : 1024;
    const int    numBlocks = std::clamp (static_cast<int> (seconds * sampleRate / avgSize), 200, 16000);

    const uint64_t diceSeed = seed * 7919ULL + 17ULL;

    auto sequencer = std::make_unique<seq::StepSequencer>();
    sequencer->setSeed (diceSeed);

    SplitMix oracleDice { diceSeed };
    legacy::LegacySequencer oracle (sampleRate, [&oracleDice, flavor]()
    {
        // With probabilities of exactly 0 or 1 the value never matters.
        return flavor == Flavor::Fractional ? oracleDice.next() : 0.5;
    });

    auto model  = std::make_unique<seq::Sequence>();
    auto before = std::make_unique<seq::Sequence>();
    const bool startWithSequence = chance (rng, 0.95);
    if (startWithSequence)
        makeSequence (rng, *model, flavor);

    // On the grid, positions are multiples of 1/16 and tempos are 60 / 120 / 240.
    auto pickPos = [&rng, grid] (double lo, double hi)
    {
        const double v = pickReal (rng, lo, hi);
        return grid ? std::floor (v * 16.0) / 16.0 : v;
    };
    auto pickTempo = [&rng, grid]()
    {
        return grid ? pick<double> (rng, { 60.0, 120.0, 240.0 }) : pickReal (rng, 60.0, 200.0);
    };

    double beatPos = pick<double> (rng, { 0.0, pickPos (0.0, 8.0), pickPos (0.0, 1.0), 1.0 });
    double bpm     = pickTempo();
    bool   playing = chance (rng, 0.85);

    legacy::MidiBuffer oracleOut;
    seq::EventBuffer out;
    seq::StepEventBuffer steps;
    bool haveStep = false;
    int  previousStep = 0;

    for (int b = 0; b < numBlocks; ++b)
    {
        const int numSamples = blockSize();

        // Edits, transport toggles and tempo changes happen at a rate set by
        // time, not by block count, so tiny blocks still get to play.
        const double blockSeconds = numSamples / sampleRate;

        bool post = false;

        if (b == 0 && startWithSequence)
        {
            post = true;
        }
        else if (chance (rng, std::clamp (blockSeconds / 0.3, 0.005, 0.5)))
        {
            before->copyFrom (*model);
            applyEdit (rng, *model, playing, beatPos, flavor);
            post = ! (playing && sameContent (*before, *model));
        }

        oracleOut.events.clear();
        out.clear();
        steps.clear();

        if (post)
            oracle.post (toLegacy (*model));
        oracle.process (beatPos, bpm, playing, numSamples, oracleOut);

        seq::BlockInfo info;
        info.beatPos    = beatPos;
        info.bpm        = bpm;
        info.playing    = playing;
        info.sampleRate = sampleRate;
        info.numSamples = numSamples;
        sequencer->process (info, post ? model.get() : nullptr, out, steps);

        ++stats.blocks;
        stats.playingEdits += (post && playing && b > 0) ? 1 : 0;
        stats.legatoBlocks += (playing && model->legato && model->numSteps > 0) ? 1 : 0;
        stats.emptyBlocks  += (playing && model->numSteps == 0) ? 1 : 0;

        bool same = static_cast<int> (oracleOut.events.size()) == out.count;
        for (int i = 0; same && i < out.count; ++i)
            same = sameEvent (oracleOut.events[static_cast<size_t> (i)], out[i]);

        const std::string stepProblem = checkStepEvents (steps, *model, playing, haveStep, previousStep);

        if (! same || ! stepProblem.empty())
        {
            char head[256];
            std::snprintf (head, sizeof head,
                           "seed %llu (%s) block %d: beatPos %.17g bpm %.17g playing %d samples %d rate %.0f%s\n",
                           static_cast<unsigned long long> (seed), name (flavor),
                           b, beatPos, bpm, playing ? 1 : 0, numSamples, sampleRate,
                           post ? " (sequence posted)" : "");

            const seq::MidiEvent* oracleBegin = oracleOut.events.data();
            return std::string (head)
                 + "      oracle:" + describe (oracleBegin, oracleBegin + oracleOut.events.size()) + "\n"
                 + "      actual:" + describe (out.begin(), out.end())
                 + (stepProblem.empty() ? "" : "\n      step events: " + stepProblem);
        }

        for (const auto& e : out)
            (e.on ? stats.noteOns : stats.noteOffs) += 1;

        // Advance the host. The position is computed exactly the way the
        // processor computes the end of a block, with this block's tempo.
        if (playing)
        {
            const double beatsPerSample = (bpm / 60.0) / sampleRate;
            beatPos = beatPos + beatsPerSample * numSamples;
        }

        // Mean 10 s playing, 2 s stopped.
        if (chance (rng, std::min (0.5, blockSeconds / (playing ? 10.0 : 2.0))))
        {
            playing = ! playing;

            if (playing)   // restart: anywhere, including earlier
            {
                switch (pickInt (rng, 0, 3))
                {
                    case 0:  break;
                    case 1:  beatPos = std::max (0.0, beatPos - pickPos (0.0, 8.0)); break;
                    case 2:  beatPos = pickPos (0.0, 40.0); break;
                    default: beatPos = std::floor (pickReal (rng, 0.0, 16.0)); break;
                }
            }
        }

        if (chance (rng, std::min (0.5, blockSeconds / 2.0)))
            bpm = chance (rng, 0.5) ? pickTempo() : std::floor (pickTempo());
    }

    ++stats.scenarios;
    return {};
}

int seedCount()
{
    if (const char* env = std::getenv ("SEQ_DIFF_SEEDS"))
        return std::max (1, std::atoi (env));
    return 2000;
}

void runAll (Flavor flavor)
{
    Stats stats;
    const int n = seedCount();
    int reported = 0;

    for (int seed = 1; seed <= n && reported < 3; ++seed)
    {
        const auto report = runScenario (static_cast<uint64_t> (seed), flavor, stats);

        if (! report.empty())
        {
            check::fail (__FILE__, __LINE__, "\n      " + report);
            ++reported;
        }
    }

    std::printf ("    %ld scenarios, %ld blocks, %ld note-ons, %ld note-offs compared; "
                 "%ld edits while playing, %ld legato blocks, %ld empty-sequence blocks\n",
                 stats.scenarios, stats.blocks, stats.noteOns, stats.noteOffs,
                 stats.playingEdits, stats.legatoBlocks, stats.emptyBlocks);

    // The scenarios must actually exercise the sequencer, or agreement means nothing.
    CHECK (stats.noteOns > 50L * n);
    CHECK (stats.playingEdits > 10L * n);
    CHECK (stats.legatoBlocks > 0);
}

} // namespace

TEST (sequencer_matches_legacy_binary_probability)
{
    runAll (Flavor::Binary);
}

TEST (sequencer_matches_legacy_fractional_probability)
{
    runAll (Flavor::Fractional);
}

TEST (sequencer_matches_legacy_on_an_exact_grid)
{
    runAll (Flavor::Grid);
}
