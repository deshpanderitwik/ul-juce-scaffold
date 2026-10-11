#pragma once

#include "../check.h"
#include "StepSequencer.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

// Shared pieces of the sequencer tests: a fake host that feeds blocks to a
// StepSequencer and logs everything it emits, a sequence builder, and the
// balance check every scenario that ends with a stop is held to.
namespace seqtest
{

struct N
{
    int    note;
    double delay;
    float  probability;

    N (int n, double d = 0.0, float p = 1.0f) : note (n), delay (d), probability (p) {}
};

using Chord = std::vector<N>;

inline std::unique_ptr<seq::Sequence> build (double stepsPerBeat, double gateMs,
                                             const std::vector<Chord>& chords,
                                             bool legato = false, int tag = 0)
{
    auto s = std::make_unique<seq::Sequence>();
    s->numSteps     = static_cast<int> (chords.size());
    s->stepsPerBeat = stepsPerBeat;
    s->gateMs       = gateMs;
    s->legato       = legato;
    s->tag          = tag;

    for (size_t i = 0; i < chords.size(); ++i)
    {
        auto& step = s->steps[i];
        step.numNotes = static_cast<int> (chords[i].size());

        for (size_t j = 0; j < chords[i].size(); ++j)
        {
            auto& n = step.notes[j];
            n.note        = static_cast<uint8_t> (chords[i][j].note);
            n.delay       = chords[i][j].delay;
            n.probability = chords[i][j].probability;
            n.velocity    = 100;
        }
    }
    return s;
}

// A chord of `count` consecutive notes from `first`.
inline Chord span (int first, int count, double delay = 0.0)
{
    Chord c;
    for (int i = 0; i < count; ++i)
        c.emplace_back (first + i, delay);
    return c;
}

inline bool near (long long a, long long b, long long tolerance = 1)
{
    return std::llabs (a - b) <= tolerance;
}

inline bool is (const seq::MidiEvent& e, bool on, int note)
{
    return e.on == on && e.note == note && e.channel == 1 && e.velocity == (on ? 100 : 0);
}

// An event placed on the host's own clock: samples since the host started.
struct Timed
{
    long long       sample = 0;
    seq::MidiEvent  event;
};

struct StepRecord
{
    long long       blockStart = 0;
    seq::StepEvent  event;
};

// Sorts by time, keeping the emission order of events on the same sample, the
// way the host's MIDI buffer will deliver them.
inline std::vector<Timed> inTimeOrder (std::vector<Timed> events)
{
    std::stable_sort (events.begin(), events.end(),
                      [] (const Timed& a, const Timed& b) { return a.sample < b.sample; });
    return events;
}

// Empty when every note-on has a matching note-off and no note-off comes
// without a note-on. Counted per note, so overlapping instances of one pitch
// need one note-off each.
inline std::string unbalanced (const std::vector<Timed>& events)
{
    std::array<int, 16 * 128> depth {};
    char buf[96];

    for (const auto& t : inTimeOrder (events))
    {
        const auto& e = t.event;
        auto& d = depth[static_cast<size_t> ((e.channel - 1) * 128 + e.note)];

        if (e.on)
        {
            ++d;
        }
        else if (d == 0)
        {
            std::snprintf (buf, sizeof buf, "note-off for %d at sample %lld has no note-on", e.note, t.sample);
            return buf;
        }
        else
        {
            --d;
        }
    }

    for (size_t i = 0; i < depth.size(); ++i)
        if (depth[i] != 0)
        {
            std::snprintf (buf, sizeof buf, "note %d is still on (%d times)", static_cast<int> (i % 128), depth[i]);
            return buf;
        }
    return {};
}

// The most notes sounding at once, in time order.
inline int mostSounding (const std::vector<Timed>& events)
{
    int now = 0, most = 0;
    for (const auto& t : inTimeOrder (events))
    {
        now += t.event.on ? 1 : -1;
        most = std::max (most, now);
    }
    return most;
}

#define CHECK_BALANCED(events)                                                          \
    do {                                                                                \
        const auto why = seqtest::unbalanced (events);                                  \
        if (! why.empty()) check::fail (__FILE__, __LINE__, "unbalanced: " + why);      \
    } while (false)

// Where the host puts the playhead. Everything is exact in binary at 65536 Hz
// and 120 bpm (32768 samples per beat), which is what the timing tests use so
// that sample positions can be compared exactly.
enum class LoopStyle
{
    Unsplit,   // the host hands over one block that runs through the loop end
    Split      // the host ends a block at the loop end and starts the next at the loop start
};

struct Host
{
    std::unique_ptr<seq::StepSequencer> sequencer = std::make_unique<seq::StepSequencer>();
    seq::StepEventBuffer steps;               // step events of the latest run()
    std::vector<Timed>      log;              // every MIDI event ever emitted
    std::vector<StepRecord> stepLog;          // every step event ever emitted

    double beatPos    = 0.0;
    double bpm        = 120.0;
    double sampleRate = 48000.0;

    bool      looping   = false;
    double    loopStart = 0.0;
    double    loopEnd   = 0.0;
    LoopStyle loopStyle = LoopStyle::Unsplit;

    long long elapsed = 0;                    // samples since the host started

    static Host grid()
    {
        Host h;
        h.sampleRate = 65536.0;
        return h;
    }

    double beatsPerSample() const             { return (bpm / 60.0) / sampleRate; }

    // Samples per beat at the current tempo, for building expected positions.
    long long samplesPerBeat() const          { return std::llround (sampleRate * 60.0 / bpm); }

    // One block, exactly as the host reports it. Returns the block's events with
    // offsets relative to the block.
    std::vector<seq::MidiEvent> process (int numSamples, bool playing, const seq::Sequence* newSequence)
    {
        seq::BlockInfo info;
        info.beatPos    = beatPos;
        info.bpm        = bpm;
        info.playing    = playing;
        info.sampleRate = sampleRate;
        info.numSamples = numSamples;
        info.looping    = looping;
        info.loopStart  = loopStart;
        info.loopEnd    = loopEnd;

        seq::EventBuffer out;
        const int stepsBefore = steps.count;
        sequencer->process (info, newSequence, out, steps);

        for (const auto& e : out)
        {
            CHECK (e.sampleOffset >= 0 && e.sampleOffset < numSamples);
            log.push_back ({ elapsed + e.sampleOffset, e });
        }
        for (int i = stepsBefore; i < steps.count; ++i)
            stepLog.push_back ({ elapsed, steps[i] });

        elapsed += numSamples;

        if (playing)
        {
            beatPos = beatPos + beatsPerSample() * numSamples;

            // A host that loops wraps its own position at the loop end.
            if (looping && loopEnd > loopStart && beatPos >= loopEnd - 1.0e-9)
                beatPos = loopStart + std::max (0.0, beatPos - loopEnd);
        }

        return { out.begin(), out.end() };
    }

    // Run one block. A host with a split-style loop cuts the block at the loop
    // end first, as Live does.
    std::vector<seq::MidiEvent> run (int numSamples, bool playing = true,
                                     const seq::Sequence* newSequence = nullptr)
    {
        steps.clear();

        if (playing && looping && loopEnd > loopStart && loopStyle == LoopStyle::Split)
        {
            const double bps    = beatsPerSample();
            const double end    = beatPos + bps * numSamples;
            const int    before = static_cast<int> (std::llround ((loopEnd - beatPos) / bps));

            if (beatPos < loopEnd && end > loopEnd + 0.25 * bps && before > 0 && before < numSamples)
            {
                auto a = process (before, true, newSequence);
                auto b = process (numSamples - before, true, nullptr);

                for (auto e : b)
                {
                    e.sampleOffset += before;
                    a.push_back (e);
                }
                return a;
            }
        }
        return process (numSamples, playing, newSequence);
    }

    // Whole blocks of one size until at least `samples` have elapsed.
    void play (long long samples, int blockSize)
    {
        for (long long done = 0; done < samples; done += blockSize)
            run (blockSize);
    }

    void stop()                               { run (32, false); }

    // Absolute sample positions of the note-ons (or note-offs) of one pitch.
    std::vector<long long> times (int note, bool on) const
    {
        std::vector<long long> r;
        for (const auto& t : log)
            if (t.event.note == note && t.event.on == on)
                r.push_back (t.sample);
        return r;
    }
};

// Calls body(blockSize) for each block size the timing tests cover, and says
// which one was running if the body recorded a failure.
template <typename F>
void atBlockSizes (F&& body)
{
    for (const int size : { 32, 512, 2048 })
    {
        const int before = check::failures();
        body (size);

        if (check::failures() != before)
            std::printf ("    ^ with blocks of %d samples\n", size);
    }
}

} // namespace seqtest
