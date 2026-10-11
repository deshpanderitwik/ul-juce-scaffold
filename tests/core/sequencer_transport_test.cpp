#include "sequencer_support.h"

#include <tuple>

// How the sequencer follows the host's transport: jumps, loops, rate changes
// and tempo ramps. Positions use the exact-in-binary grid host (65536 Hz,
// 120 bpm, 32768 samples per beat), so sample positions are compared exactly
// wherever the code under test rounds nothing itself.
using namespace seqtest;

namespace
{

constexpr long long kBeat = 32768;

// A note-off due exactly where a block ends is emitted on that block's last
// sample, so note-offs are compared to within one sample.
bool offNear (long long actual, long long expected)
{
    return near (actual, expected, 1);
}

std::vector<int> playedOf (const seq::StepEvent& e)
{
    return { e.played.begin(), e.played.begin() + e.numPlayed };
}

// ---- jumps ---------------------------------------------------------------------

// Two notes that last a full beat, struck on every beat.
std::unique_ptr<seq::Sequence> beatChord()
{
    return build (1.0, 2000.0, { { 60, 64 } });
}

}

TEST (sequencer_a_jump_in_either_direction_ends_what_is_sounding)
{
    for (const bool forward : { false, true })
        atBlockSizes ([forward] (int size)
        {
            auto host = Host::grid();
            auto s    = beatChord();

            host.run (size, true, s.get());
            host.play (2 * kBeat + kBeat / 2 - size, size);   // half way through step 2: both notes on

            const long long jumpAt = host.elapsed;
            host.beatPos = forward ? 6.5 : 1.5;               // mid-step either way
            const auto events = host.run (size);

            REQUIRE (events.size() == 2);
            CHECK (is (events[0], false, 60));
            CHECK (is (events[1], false, 64));
            CHECK_EQ (events[0].sampleOffset, 0);
            CHECK_EQ (events[1].sampleOffset, 0);

            // The notes' own note-offs, due at beat 3, do not come a second time.
            host.play (4 * kBeat, size);
            host.stop();
            CHECK_EQ (host.times (60, false).size(), host.times (60, true).size());
            CHECK_BALANCED (host.log);

            // The step position was reset: the next boundary after the landing is
            // the one that plays.
            const int expectedNext = forward ? 7 : 2;
            bool seen = false;
            for (const auto& r : host.stepLog)
                seen = seen || (r.blockStart >= jumpAt && r.event.index == expectedNext);
            CHECK (seen);
        });
}

namespace
{

// Two legato chords that share only 60, one step per beat. A legato note has no
// gate: nothing but the jump (or a chord change) ever ends it.
std::vector<int> legatoChord (long long step)
{
    return step % 2 == 0 ? std::vector<int> { 60, 64, 67 } : std::vector<int> { 60, 65 };
}

// The notes of `events` at `sample` (absolute) that switch on or off, sorted.
std::vector<int> notesAt (const std::vector<Timed>& events, long long sample, bool on)
{
    std::vector<int> r;
    for (const auto& t : events)
        if (t.sample == sample && t.event.on == on)
            r.push_back (t.event.note);
    std::sort (r.begin(), r.end());
    return r;
}

std::vector<int> difference (const std::vector<int>& a, const std::vector<int>& b)
{
    std::vector<int> r;
    for (const int n : a)
        if (std::find (b.begin(), b.end(), n) == b.end())
            r.push_back (n);
    return r;
}

}

TEST (sequencer_a_jump_releases_legato_notes_and_the_chord_is_struck_again)
{
    struct Case
    {
        long long soundingStep;   // the jump comes half way through this step
        double    landing;        // beat the host jumps to
        bool      nearBoundary;   // lands `size - 1` samples past that beat, a boundary
    };

    // Forward and backward, in the middle of a step and just past a boundary.
    const Case cases[] = { { 2, 6.5,  false },
                           { 5, 2.5,  false },
                           { 3, 8.0,  true  },
                           { 6, 3.0,  true  } };

    for (const auto& c : cases)
        atBlockSizes ([c] (int size)
        {
            auto host = Host::grid();
            auto s    = build (1.0, 100.0, { { 60, 64, 67 }, { 60, 65 } }, true);

            host.run (size, true, s.get());
            host.play (c.soundingStep * kBeat + kBeat / 2 - size, size);

            const auto held = legatoChord (c.soundingStep);

            const long long jumpAt  = host.elapsed;
            const double    landing = c.landing + (c.nearBoundary ? static_cast<double> (size - 1) / kBeat : 0.0);
            const long long landed  = static_cast<long long> (std::floor (landing));

            host.beatPos = landing;
            host.run (size);

            // Every held note ends at sample 0 of the landing block, whatever the
            // chord that comes next.
            CHECK (notesAt (host.log, jumpAt, false) == held);

            // A landing just past a boundary strikes that step's whole chord, none
            // of it left over from before the jump; otherwise nothing is struck yet.
            std::vector<int> sounding;
            if (c.nearBoundary)
            {
                sounding = legatoChord (landed);
                CHECK (notesAt (host.log, jumpAt, true) == sounding);

                // Released first, then struck, as the host will deliver them.
                const auto ordered = inTimeOrder (host.log);
                bool seenOn = false, offAfterOn = false;
                for (const auto& t : ordered)
                    if (t.sample == jumpAt)
                    {
                        seenOn     = seenOn || t.event.on;
                        offAfterOn = offAfterOn || (seenOn && ! t.event.on);
                    }
                CHECK (! offAfterOn);

                REQUIRE (host.steps.count == 1);
                CHECK_EQ (host.steps[0].index, static_cast<int> (landed));
            }
            else
            {
                CHECK (notesAt (host.log, jumpAt, true).empty());
                CHECK_EQ (host.steps.count, 0);
            }

            // The next boundary changes only what differs from what is sounding
            // now: the whole chord when the jump left nothing, the diff when the
            // landing already struck a chord.
            const long long boundary = jumpAt + std::llround ((static_cast<double> (landed + 1) - landing) * kBeat);
            const auto next = legatoChord (landed + 1);

            host.play (kBeat + size, size);

            CHECK (notesAt (host.log, boundary, true) == difference (next, sounding));
            CHECK (notesAt (host.log, boundary, false) == difference (sounding, next));

            // Nothing else touched those notes in between, so the chord rings on.
            host.stop();
            CHECK_BALANCED (host.log);
        });
}

TEST (sequencer_a_forward_jump_drops_phrased_notes_that_have_not_fired)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (1.0, 250.0, { { N (60, 0.9) } });

        host.run (size, true, s.get());
        host.play (kBeat / 2 - size, size);   // the phrased note is due at beat 0.9

        const long long jumpAt = host.elapsed;
        host.beatPos = 5.5;                   // well past it
        CHECK (host.run (size).empty());      // it must not fire late, at the landing

        host.play (2 * kBeat, size);
        host.stop();

        // The only one is the next step's own, at beat 6.9: 1.4 beats after the landing.
        const auto ons = host.times (60, true);
        REQUIRE (ons.size() == 1);
        CHECK (near (ons[0], jumpAt + 45875));
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_the_first_block_after_a_stop_is_a_start_not_a_jump)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (1.0, 250.0, { { 60 } });

        host.run (size, true, s.get());
        host.play (kBeat / 2 - size, size);
        host.stop();

        // Starting 10 samples after a boundary: as a jump this would be caught up
        // (the boundary is within a block), as a start it is not.
        host.beatPos = 3.0 + 10.0 / kBeat;
        CHECK (host.run (size).empty());
        host.play (2 * kBeat, size);

        REQUIRE (! host.stepLog.empty());
        CHECK_EQ (host.stepLog.back().event.index >= 4, true);
        bool playedStep3 = false;
        for (const auto& r : host.stepLog)
            playedStep3 = playedStep3 || (r.blockStart > 0 && r.event.index == 3);
        CHECK (! playedStep3);

        // Starting earlier than where it stopped is fine too.
        host.stop();
        host.beatPos = 0.25;
        CHECK (host.run (size).empty());

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_a_jump_landing_just_past_a_boundary_catches_that_step_up)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (1.0, 2000.0, { { 60 }, { 62 } });

        host.run (size, true, s.get());
        host.play (3 * kBeat + kBeat / 2 - size, size);   // 60/62 alternate; step 3 (62) is sounding

        // Landing `size - 1` samples after beat 8 is within a block of the
        // boundary: step 8 plays at the landing, together with the note-off for
        // what was sounding.
        host.beatPos = 8.0 + static_cast<double> (size - 1) / kBeat;
        const auto events = host.run (size);

        REQUIRE (events.size() == 2);
        CHECK (is (events[0], false, 62));
        CHECK (is (events[1], true, 60));
        CHECK_EQ (events[0].sampleOffset, 0);
        CHECK_EQ (events[1].sampleOffset, 0);

        REQUIRE (host.steps.count == 1);
        CHECK_EQ (host.steps[0].index, 8);
        CHECK (playedOf (host.steps[0]) == (std::vector<int> { 60 }));

        // And the boundary after it is the next one, once.
        host.play (kBeat, size);
        REQUIRE (host.stepLog.size() >= 2);
        CHECK_EQ (host.stepLog.back().event.index, 9);
    });
}

TEST (sequencer_a_jump_landing_further_than_a_block_past_a_boundary_waits_for_the_next)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (1.0, 2000.0, { { 60 }, { 62 } });

        host.run (size, true, s.get());
        host.play (3 * kBeat + kBeat / 2 - size, size);

        host.beatPos = 8.0 + static_cast<double> (size + 1) / kBeat;
        const auto events = host.run (size);

        REQUIRE (events.size() == 1);
        CHECK (is (events[0], false, 62));
        CHECK_EQ (host.steps.count, 0);
    });
}

TEST (sequencer_a_jump_landing_on_a_boundary_plays_that_step_once)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (1.0, 2000.0, { { 60 }, { 62 } });

        host.run (size, true, s.get());
        host.play (3 * kBeat + kBeat / 2 - size, size);

        host.beatPos = 8.0;
        const auto events = host.run (size);

        REQUIRE (events.size() == 2);
        CHECK (is (events[0], false, 62));
        CHECK (is (events[1], true, 60));
        REQUIRE (host.steps.count == 1);
        CHECK_EQ (host.steps[0].index, 8);
    });
}

TEST (sequencer_a_catch_up_step_of_an_empty_sequence_is_still_reported)
{
    auto host  = Host::grid();
    auto empty = build (2.0, 100.0, {});

    host.run (512, true, empty.get());
    host.play (kBeat, 512);

    host.beatPos = 20.0 + 100.0 / kBeat;   // 100 samples past step 40
    host.run (512);

    REQUIRE (host.steps.count == 1);
    CHECK_EQ (host.steps[0].index, 40);
    CHECK (host.log.empty());
}

TEST (sequencer_small_position_differences_are_not_jumps)
{
    // 1/64 beat is 512 samples here.
    for (const long long shift : { -400LL, 400LL })
        atBlockSizes ([shift] (int size)
        {
            auto host = Host::grid();
            auto s    = beatChord();

            host.run (size, true, s.get());
            host.play (kBeat / 4 - size, size);

            host.beatPos += static_cast<double> (shift) / kBeat;
            CHECK (host.run (size).empty());   // nothing cut off, nothing struck again

            host.play (kBeat, size);
            host.stop();
            CHECK_EQ (host.times (60, true).size(), 2u);
            CHECK_BALANCED (host.log);
        });
}

TEST (sequencer_position_differences_beyond_a_sixty_fourth_of_a_beat_are_jumps)
{
    for (const long long shift : { -700LL, 700LL })
        atBlockSizes ([shift] (int size)
        {
            auto host = Host::grid();
            auto s    = beatChord();

            host.run (size, true, s.get());
            host.play (kBeat / 4 - size, size);

            host.beatPos += static_cast<double> (shift) / kBeat;
            const auto events = host.run (size);

            REQUIRE (events.size() == 2);
            CHECK (! events[0].on);
            CHECK (! events[1].on);
        });
}

// ---- loops -----------------------------------------------------------------------

namespace
{

// A one-bar loop of eight half-beat steps with a distinct pitch each (60..67).
// The last step is phrased so that its note straddles the wrap when asked to.
std::unique_ptr<seq::Sequence> loopSteps (double lastStepDelay = 0.0)
{
    std::vector<Chord> chords;
    for (int i = 0; i < 7; ++i)
        chords.push_back ({ N (60 + i) });
    chords.push_back ({ N (67, lastStepDelay) });

    return build (2.0, 1000.0, chords);   // the gate is capped at one step: 16384 samples
}

Host loopHost (LoopStyle style, double loopStart, double loopEnd, long long phase)
{
    auto host = Host::grid();
    host.looping   = true;
    host.loopStart = loopStart;
    host.loopEnd   = loopEnd;
    host.loopStyle = style;
    host.beatPos   = loopStart + static_cast<double> (phase) / kBeat;
    return host;
}

struct Pass
{
    LoopStyle style;
    const char* name;
};

const Pass kStyles[] = { { LoopStyle::Unsplit, "unsplit" }, { LoopStyle::Split, "split" } };

void playBlocks (Host& host, long long samples, int size, const seq::Sequence* first)
{
    host.run (size, true, first);
    host.play (samples - size, size);
}

}

TEST (sequencer_a_wrapped_loop_plays_the_downbeat_once_per_pass_at_the_right_sample)
{
    for (const auto& style : kStyles)
        atBlockSizes ([&style] (int size)
        {
            const long long phase = 100, bar = 4 * kBeat, total = 3 * bar;
            auto host = loopHost (style.style, 0.0, 4.0, phase);
            auto s    = loopSteps();

            playBlocks (host, total, size, s.get());

            // Step j of a pass sounds at pass * bar + j * 16384 on the host's clock,
            // which started `phase` samples into the loop.
            std::vector<std::pair<long long, int>> expected, actual;
            for (long long pass = 0; pass <= 3; ++pass)
                for (int j = 0; j < 8; ++j)
                {
                    const long long t = pass * bar + j * 16384 - phase;
                    if (t >= 0 && t < total)
                        expected.push_back ({ t, 60 + j });
                }

            for (const auto& t : host.log)
                if (t.event.on)
                    actual.push_back ({ t.sample, t.event.note });
            std::sort (actual.begin(), actual.end());

            CHECK (actual == expected);

            // One note-off per note, one step later.
            for (const auto& e : expected)
            {
                if (e.first + 16384 + 2 >= total)
                    continue;

                int offs = 0;
                for (const auto& t : host.log)
                    if (! t.event.on && t.event.note == e.second && offNear (t.sample, e.first + 16384))
                        ++offs;
                CHECK_EQ (offs, 1);
            }

            // The step numbers wrap with the loop: 1..7, then 0 again.
            std::vector<int> indices;
            for (const auto& r : host.stepLog)
                indices.push_back (r.event.index);
            for (size_t i = 1; i < indices.size(); ++i)
                CHECK_EQ (indices[i], (indices[i - 1] + 1) % 8);

            host.stop();
            CHECK_BALANCED (host.log);
        });
}

TEST (sequencer_both_loop_styles_produce_the_same_stream)
{
    for (const long long phase : { 7LL, 100LL, 1000LL, 16384LL - 5 })
        atBlockSizes ([phase] (int size)
        {
            std::vector<std::vector<std::tuple<long long, bool, int>>> streams;
            std::vector<std::vector<std::pair<int, std::vector<int>>>> steps;

            for (const auto& style : kStyles)
            {
                auto host = loopHost (style.style, 0.0, 4.0, phase);
                auto s    = loopSteps (0.5);   // a phrased note across the wrap, too

                playBlocks (host, 3 * 4 * kBeat, size, s.get());
                host.stop();

                streams.emplace_back();
                for (const auto& t : host.log)
                    streams.back().push_back ({ t.sample, t.event.on, t.event.note });
                std::sort (streams.back().begin(), streams.back().end());

                steps.emplace_back();
                for (const auto& r : host.stepLog)
                    steps.back().push_back ({ r.event.index, playedOf (r.event) });
            }

            CHECK (! streams[0].empty());
            CHECK (streams[0] == streams[1]);
            CHECK (steps[0] == steps[1]);
        });
}

namespace
{

// A block of a host that splits at the loop end and keeps the timeline
// continuous: the first part is a whole number of samples, and the second
// starts wherever the first one's samples ran out, which is a fraction of a
// sample before or after the loop start.
void runSplitContinuous (Host& host, int size, const seq::Sequence* newSequence)
{
    host.steps.clear();

    const double bps    = host.beatsPerSample();
    const double start  = host.beatPos;
    const double end    = start + bps * size;
    const int    before = static_cast<int> (std::llround ((host.loopEnd - start) / bps));

    if (start < host.loopEnd && end > host.loopEnd + 0.25 * bps && before > 0 && before < size)
    {
        host.process (before, true, newSequence);
        host.beatPos = host.loopStart + (start + bps * before - host.loopEnd);
        host.process (size - before, true, nullptr);
    }
    else
    {
        host.process (size, true, newSequence);
    }
}

}

TEST (sequencer_both_loop_styles_produce_the_same_stream_when_the_wrap_falls_between_samples)
{
    struct Setup
    {
        double sampleRate, bpm, loopStart, loopEnd, phaseSamples;
    };

    const Setup setups[] = { { 44100.0, 127.0, 1.0, 5.0,  37.3 },
                             { 44100.0, 127.0, 1.0, 5.0, 901.6 },
                             { 44100.0, 127.0, 0.5, 3.75, 12.9 },
                             { 48000.0, 133.7, 0.0, 4.0, 211.2 },
                             { 48000.0,  93.1, 2.0, 6.5, 5.5 } };

    for (const auto& setup : setups)
        atBlockSizes ([&setup] (int size)
        {
            std::vector<Host> hosts;

            for (const auto style : { LoopStyle::Unsplit, LoopStyle::Split })
            {
                Host host;
                host.sampleRate = setup.sampleRate;
                host.bpm        = setup.bpm;
                host.looping    = true;
                host.loopStart  = setup.loopStart;
                host.loopEnd    = setup.loopEnd;
                host.beatPos    = setup.loopStart + setup.phaseSamples * host.beatsPerSample();

                auto s = loopSteps (0.5);   // a phrased note across the wrap, too

                const long long total = static_cast<long long> (
                    std::llround (3.0 * (setup.loopEnd - setup.loopStart) * setup.sampleRate * 60.0 / setup.bpm));

                for (long long done = 0; done < total; done += size)
                {
                    const seq::Sequence* first = done == 0 ? s.get() : nullptr;

                    if (style == LoopStyle::Split)
                        runSplitContinuous (host, size, first);
                    else
                        host.run (size, true, first);
                }
                host.stop();

                CHECK_BALANCED (host.log);
                hosts.push_back (std::move (host));
            }

            // The same events, to within the sample a block boundary can move one by.
            const auto& unsplit = hosts[0];
            const auto& split   = hosts[1];

            CHECK (! unsplit.log.empty());

            for (int note = 0; note < 128; ++note)
                for (const bool on : { false, true })
                {
                    auto a = unsplit.times (note, on);
                    auto b = split.times (note, on);
                    std::sort (a.begin(), a.end());
                    std::sort (b.begin(), b.end());

                    REQUIRE (a.size() == b.size());
                    for (size_t i = 0; i < a.size(); ++i)
                        CHECK (near (a[i], b[i], 1));
                }

            // The same steps, with the same notes, in the same order.
            REQUIRE (unsplit.stepLog.size() == split.stepLog.size());
            for (size_t i = 0; i < unsplit.stepLog.size(); ++i)
            {
                const auto& x = unsplit.stepLog[i].event;
                const auto& y = split.stepLog[i].event;

                CHECK_EQ (x.index, y.index);
                CHECK_EQ (x.stepsPerBeat, y.stepsPerBeat);
                CHECK_EQ (x.tag, y.tag);
                CHECK (playedOf (x) == playedOf (y));
            }
        });
}

TEST (sequencer_a_gate_that_crosses_the_wrap_ends_once_in_the_right_place)
{
    for (const auto& style : kStyles)
        atBlockSizes ([&style] (int size)
        {
            const long long phase = 100, bar = 4 * kBeat;
            auto host = loopHost (style.style, 0.0, 4.0, phase);
            auto s    = loopSteps (0.5);   // 67 starts at beat 3.75 and lasts until 4.25

            playBlocks (host, 4 * bar, size, s.get());
            host.stop();

            const auto ons  = host.times (67, true);
            const auto offs = host.times (67, false);

            // Passes 0 to 3 each have a note at 3.75; the host's clock is `phase` ahead.
            REQUIRE (ons.size() == 4);
            REQUIRE (offs.size() == 4);   // the last one ends at the stop or after the wrap, never twice

            for (size_t pass = 0; pass < 3; ++pass)
            {
                const long long on = static_cast<long long> (pass) * bar + 15 * kBeat / 4 - phase;
                CHECK_EQ (ons[pass], on);
                CHECK (offNear (offs[pass], on + 16384));   // a quarter of a beat past the wrap + the rest of the gate
            }
            CHECK_BALANCED (host.log);
        });
}

TEST (sequencer_a_phrased_note_due_after_the_loop_end_fires_after_the_wrap)
{
    for (const auto& style : kStyles)
        atBlockSizes ([&style] (int size)
        {
            // A 3.75-beat loop: step 7 begins at 3.5 and its note is phrased to
            // 3.875, beyond the loop end. After the wrap it is due 0.125 beat in.
            const long long phase = 100, loopLength = 15 * kBeat / 4;
            auto host = loopHost (style.style, 0.0, 3.75, phase);
            auto s    = loopSteps (0.75);

            playBlocks (host, 4 * loopLength, size, s.get());
            host.stop();

            const auto ons  = host.times (67, true);
            const auto offs = host.times (67, false);

            REQUIRE (ons.size() >= 3);
            REQUIRE (offs.size() >= 3);

            for (long long pass = 1; pass <= 3; ++pass)
            {
                const long long wrap = pass * loopLength - phase;

                CHECK (std::count (ons.begin(), ons.end(), wrap + 4096) == 1);
                CHECK (std::count_if (offs.begin(), offs.end(),
                                      [wrap] (long long t) { return offNear (t, wrap + 4096 + 16384); }) == 1);
            }
            CHECK_BALANCED (host.log);
        });
}

TEST (sequencer_legato_notes_carry_on_through_the_wrap)
{
    for (const auto& style : kStyles)
        atBlockSizes ([&style] (int size)
        {
            const long long phase = 100, bar = 4 * kBeat;
            auto host = loopHost (style.style, 0.0, 4.0, phase);
            auto s    = build (1.0, 100.0, { { 60, 64 }, { 60, 67 }, { 60, 64 }, { 60, 67 } }, true);

            playBlocks (host, 3 * bar, size, s.get());

            // 60 is in every chord: struck once, and not released at any wrap.
            CHECK_EQ (host.times (60, true).size(), 1u);
            CHECK_EQ (host.times (60, false).size(), 0u);

            // The wrap changes 67 for 64 on the same sample.
            const long long wrap = bar - phase;
            const auto offs67 = host.times (67, false);
            const auto ons64  = host.times (64, true);

            REQUIRE (! offs67.empty());
            CHECK (std::count (offs67.begin(), offs67.end(), wrap) == 1);
            CHECK (std::count (ons64.begin(), ons64.end(), wrap) == 1);

            host.stop();
            CHECK_EQ (host.times (60, false).size(), 1u);
            CHECK_BALANCED (host.log);
        });
}

TEST (sequencer_a_block_that_ends_at_the_loop_end_does_not_play_the_downbeat_twice)
{
    // A host that splits at the loop end ends its block at the loop end give or
    // take rounding: a hair beyond it must not play the boundary there as well
    // as the one at the loop start.
    const double sample = 1.0 / kBeat;

    for (const double eps : { 0.0, 1.0e-12, -1.0e-12, 0.4 * sample, -0.4 * sample })
    {
        seq::StepSequencer sequencer;
        seq::StepEventBuffer steps;
        seq::EventBuffer out;

        auto s = build (1.0, 100.0, { { 60 }, { 62 }, { 64 }, { 65 } });

        seq::BlockInfo a;
        a.beatPos    = 3.5 + eps;
        a.sampleRate = 65536.0;
        a.numSamples = 16384;
        a.playing    = true;
        a.looping    = true;
        a.loopStart  = 0.0;
        a.loopEnd    = 4.0;

        sequencer.process (a, s.get(), out, steps);
        CHECK_EQ (steps.count, 0);

        auto b      = a;
        b.beatPos   = 0.0;
        b.numSamples = 16384;
        sequencer.process (b, nullptr, out, steps);

        REQUIRE (steps.count == 1);
        CHECK_EQ (steps[0].index, 0);

        int downbeats = 0;
        for (const auto& e : out)
            downbeats += (e.on && e.note == 60) ? 1 : 0;
        CHECK_EQ (downbeats, 1);
    }
}

namespace
{

// Feeds blocks placed by hand, so a test can put a block's start a fraction of
// a sample away from where the previous one ended.
struct Placed
{
    seq::StepSequencer      sequencer;
    seq::StepEventBuffer    steps;
    std::vector<Timed>      log;
    std::vector<StepRecord> stepLog;
    long long               elapsed = 0;

    seq::BlockInfo proto;

    Placed()
    {
        proto.sampleRate = 65536.0;
        proto.bpm        = 120.0;
        proto.playing    = true;
    }

    void block (double beatPos, int numSamples, const seq::Sequence* newSequence = nullptr)
    {
        auto info       = proto;
        info.beatPos    = beatPos;
        info.numSamples = numSamples;

        seq::EventBuffer out;
        steps.clear();
        sequencer.process (info, newSequence, out, steps);

        for (const auto& e : out)
            log.push_back ({ elapsed + e.sampleOffset, e });
        for (const auto& e : steps)
            stepLog.push_back ({ elapsed, e });

        elapsed += numSamples;
    }

    void stop()
    {
        proto.playing = false;
        block (0.0, 32);
    }
};

}

TEST (sequencer_a_block_after_the_loop_end_that_starts_off_the_loop_start_is_still_a_wrap)
{
    // Hosts that split at the loop end carry their rounding into the next
    // block: it starts a fraction of a sample before or after the loop start.
    const double sample = 1.0 / kBeat;

    for (const double offset : { -5.0, -0.45, -0.3, 0.0, 0.3, 0.45, 5.0 })
    {
        Placed p;
        p.proto.looping   = true;
        p.proto.loopStart = 1.0;
        p.proto.loopEnd   = 5.0;

        // Each step strikes a note on the beat and another half a beat later;
        // both last a beat.
        std::vector<Chord> chords;
        for (int k = 0; k < 4; ++k)
            chords.push_back ({ N (60 + 2 * k), N (61 + 2 * k, 0.5) });
        auto s = build (1.0, 500.0, chords);

        p.block (3.5, 24576, s.get());   // step 4 strikes 60 at 4.0 and queues 61 for 4.5
        p.block (4.25, 16384);           // 61 starts at 4.5, due off at 5.5: past the loop end
        p.block (4.75, 8192);            // ends at the loop end; 60 ends there
        p.block (1.0 + offset * sample, 20000);

        constexpr long long wrapBlock = 24576 + 16384 + 8192;
        auto local = [] (const Timed& t) { return t.sample - wrapBlock; };

        // Not a jump: 61 is still sounding and ends where its gate says, a beat
        // and a half into the loop, not at sample 0.
        int offs61 = 0;
        for (const auto& t : p.log)
            if (! t.event.on && t.event.note == 61)
            {
                ++offs61;
                CHECK (local (t) > 0);
                CHECK (near (local (t), static_cast<long long> (16384 - offset), 1));
            }
        CHECK_EQ (offs61, 1);

        // One downbeat, played at the start of the block.
        int downbeats = 0;
        for (const auto& t : p.log)
            if (t.event.on && t.event.note == 62)
            {
                ++downbeats;
                CHECK (local (t) >= 0 && local (t) <= static_cast<long long> (std::max (0.0, -offset)) + 1);
            }
        CHECK_EQ (downbeats, 1);

        // And the note struck half a beat after it, once.
        int phrased = 0;
        for (const auto& t : p.log)
            phrased += (t.event.on && t.event.note == 63) ? 1 : 0;
        CHECK_EQ (phrased, 1);

        // Step 1 is reported once; no step is played twice or skipped.
        std::vector<int> indices;
        for (const auto& r : p.stepLog)
            indices.push_back (r.event.index);
        CHECK (indices == (std::vector<int> { 4, 1 }));

        p.stop();
        CHECK_BALANCED (p.log);
    }
}

TEST (sequencer_a_block_after_the_loop_end_that_lands_elsewhere_is_a_jump)
{
    for (const auto& style : kStyles)
    {
        auto host = loopHost (style.style, 0.0, 4.0, 0);
        auto s    = loopSteps (0.5);

        host.run (512, true, s.get());
        host.play (4 * kBeat - 2048 - 512, 512);
        host.run (2048);                          // the block that ends exactly at the loop end
        host.stepLog.clear();

        // 67 is sounding (started at 3.75, due off at 4.25). The host does not wrap.
        host.beatPos = 2.0;
        const auto events = host.run (512);

        REQUIRE (events.size() >= 1);
        CHECK (is (events[0], false, 67));
        CHECK_EQ (events[0].sampleOffset, 0);

        host.stop();
        CHECK_EQ (host.times (67, false).size(), host.times (67, true).size());
        CHECK_BALANCED (host.log);
    }
}

TEST (sequencer_a_playhead_before_the_loop_runs_straight_into_it)
{
    for (const auto& style : kStyles)
        atBlockSizes ([&style] (int size)
        {
            // Start two beats ahead of the loop [2, 4): it plays on up to 4, then wraps.
            auto host = loopHost (style.style, 2.0, 4.0, 0);
            host.beatPos = 100.0 / kBeat;
            auto s = loopSteps();

            playBlocks (host, 6 * kBeat, size, s.get());
            host.stop();

            // Steps 1 to 7 play on the way in, 4 to 7 on the second pass through
            // the loop, and the run ends just after the second wrap, on step 4.
            std::vector<int> indices;
            for (const auto& r : host.stepLog)
                indices.push_back (r.event.index);

            const std::vector<int> expected { 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7, 4 };
            CHECK (indices == expected);
            CHECK_BALANCED (host.log);
        });
}

// ---- a changed rate while playing --------------------------------------------------

TEST (sequencer_a_slower_rate_posted_while_playing_does_not_stall)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto fast = build (8.0, 2000.0, { { 60 } }, false, 1);          // a step is 4096 samples
        auto slow = build (1.0, 2000.0, { { 70 }, { 72 } }, false, 2);   // a step is a beat

        host.run (size, true, fast.get());
        host.play (337920 - size, size);   // beat 10.3125, half way through fast step 82

        const long long switchedAt = host.elapsed;
        host.run (size, true, slow.get());
        host.play (2 * kBeat, size);

        // The next boundary of the new grid is beat 11: step 11, an odd step, so 72.
        const auto ons = host.times (72, true);
        REQUIRE (! ons.empty());
        CHECK_EQ (ons.front(), 11 * kBeat);
        CHECK (host.times (70, true).front() == 12 * kBeat);

        // The step events follow the new grid at once.
        const StepRecord* first = nullptr;
        for (const auto& r : host.stepLog)
            if (r.blockStart >= switchedAt)
            {
                first = &r;
                break;
            }
        REQUIRE (first != nullptr);
        CHECK_EQ (first->event.index, 11);
        CHECK_EQ (first->event.stepsPerBeat, 1.0);
        CHECK_EQ (first->event.tag, 2);

        // The note that was sounding rings out to its own scheduled end, once.
        const auto offs = host.times (60, false);
        REQUIRE (offs.size() >= 1);
        CHECK (offNear (offs.back(), 337920 + 2048));   // beat 10.375: fast step 82's gate
        CHECK_EQ (host.times (60, true).size(), offs.size());

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_a_faster_rate_posted_while_playing_starts_at_the_next_boundary)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto slow = build (1.0, 2000.0, { { 70 }, { 72 } }, false, 1);
        auto fast = build (4.0, 2000.0, { { 60 } }, false, 2);

        host.run (size, true, slow.get());
        host.play (337920 - size, size);   // beat 10.3125
        host.run (size, true, fast.get());
        host.play (kBeat, size);

        // Quarter-beat steps: the next boundary is beat 10.5, step 42.
        REQUIRE (! host.times (60, true).empty());
        CHECK_EQ (host.times (60, true).front(), 10 * kBeat + kBeat / 2);

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_a_rate_posted_exactly_on_a_new_boundary_plays_it_at_once)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto fast = build (8.0, 2000.0, { { 60 } });
        auto slow = build (1.0, 2000.0, { { 70 } });

        host.run (size, true, fast.get());
        host.play (360448 - size, size);   // exactly beat 11

        host.run (size, true, slow.get());

        REQUIRE (! host.times (70, true).empty());
        CHECK_EQ (host.times (70, true).front(), 11 * kBeat);

        REQUIRE (host.stepLog.size() >= 1);
        CHECK_EQ (host.stepLog.back().event.index, 11);
    });
}

TEST (sequencer_a_new_rate_does_not_strike_the_edit_into_the_step_in_progress)
{
    auto host = Host::grid();
    auto fast = build (8.0, 2000.0, { { 60 } });
    auto slow = build (1.0, 2000.0, { { 60, 64 } });

    host.run (512, true, fast.get());
    host.play (337920 - 512, 512);

    for (const auto& e : host.run (512, true, slow.get()))
        CHECK (! (e.on && e.note == 64));   // 64 waits for the next boundary
}

TEST (sequencer_a_rate_posted_into_a_cleared_sequence_does_not_stall)
{
    atBlockSizes ([] (int size)
    {
        auto host  = Host::grid();
        auto empty = build (8.0, 2000.0, {});
        auto slow  = build (1.0, 2000.0, { { 70 }, { 72 } });

        host.run (size, true, empty.get());
        host.play (337920 - size, size);

        host.run (size, true, slow.get());
        host.play (2 * kBeat, size);

        REQUIRE (! host.times (72, true).empty());
        CHECK_EQ (host.times (72, true).front(), 11 * kBeat);
    });
}

TEST (sequencer_a_slower_rate_posted_in_a_block_of_no_samples_does_not_stall)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto fast = build (8.0, 2000.0, { { 60 } }, false, 1);
        auto slow = build (1.0, 2000.0, { { 70 }, { 72 } }, false, 2);

        host.run (size, true, fast.get());
        host.play (337920 - size, size);   // beat 10.3125, half way through fast step 82

        const long long switchedAt = host.elapsed;
        host.run (0, true, slow.get());
        host.play (2 * kBeat, size);

        // The next boundary of the new grid is beat 11: step 11, an odd step, so 72.
        REQUIRE (! host.times (72, true).empty());
        CHECK_EQ (host.times (72, true).front(), 11 * kBeat);

        const StepRecord* first = nullptr;
        for (const auto& r : host.stepLog)
            if (r.blockStart >= switchedAt)
            {
                first = &r;
                break;
            }
        REQUIRE (first != nullptr);
        CHECK_EQ (first->event.index, 11);
        CHECK_EQ (first->event.stepsPerBeat, 1.0);
        CHECK_EQ (first->event.tag, 2);

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_a_faster_rate_posted_in_a_block_of_no_samples_starts_at_the_next_boundary)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto slow = build (1.0, 2000.0, { { 70 }, { 72 } }, false, 1);
        auto fast = build (4.0, 2000.0, { { 60 } }, false, 2);

        host.run (size, true, slow.get());
        host.play (337920 - size, size);   // beat 10.3125
        host.run (0, true, fast.get());
        host.play (kBeat, size);

        // Quarter-beat steps: the next boundary is beat 10.5, and the steps of the
        // old count that the new rate has already passed are not played.
        REQUIRE (! host.times (60, true).empty());
        CHECK_EQ (host.times (60, true).front(), 10 * kBeat + kBeat / 2);
        CHECK_EQ (host.times (60, true).size(), 4u);   // beats 10.5, 10.75, 11 and 11.25

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_a_sequence_with_the_same_rate_posted_in_a_block_of_no_samples_is_adopted)
{
    auto host = Host::grid();
    auto one  = build (1.0, 2000.0, { { 70 }, { 72 } }, false, 1);
    auto two  = build (1.0, 2000.0, { { 70 }, { 74 } }, false, 2);

    host.run (512, true, one.get());
    host.play (337920 - 512, 512);   // beat 10.3125
    const long long postedAt = host.elapsed;
    host.run (0, true, two.get());
    host.play (2 * kBeat, 512);

    // Step 11 is the odd one: the new chord, struck on the grid, with no stall.
    REQUIRE (! host.times (74, true).empty());
    CHECK_EQ (host.times (74, true).front(), 11 * kBeat);
    for (const auto sample : host.times (72, true))
        CHECK (sample < postedAt);
    CHECK_EQ (host.stepLog.back().event.tag, 2);
}

// ---- tempo ramps --------------------------------------------------------------------

namespace
{

// A host that integrates the tempo within the block: the tempo is a linear
// function of the beat position, the position advances sample by sample along
// it, and the block is announced with the position and tempo at its start.
struct RampResult
{
    std::vector<Timed>      midi;
    std::vector<double>     beatAtSample;   // the integrated position of every sample
    std::vector<seq::StepEvent> steps;
};

RampResult runRamp (double fromBpm, double toBpm, int size, const seq::Sequence& sequence)
{
    const double sampleRate = 44100.0;
    const double rampBeats  = 16.0;                 // four bars of 4/4
    auto tempoAt = [=] (double beat)
    {
        const double x = std::min (1.0, std::max (0.0, beat / rampBeats));
        return fromBpm + (toBpm - fromBpm) * x;
    };

    RampResult r;
    seq::StepSequencer sequencer;
    seq::StepEventBuffer steps;

    double beat = 0.0;
    long long elapsed = 0;
    bool first = true;

    while (beat < rampBeats)
    {
        seq::BlockInfo info;
        info.beatPos    = beat;
        info.bpm        = tempoAt (beat);
        info.playing    = true;
        info.sampleRate = sampleRate;
        info.numSamples = size;

        seq::EventBuffer out;
        steps.clear();
        sequencer.process (info, first ? &sequence : nullptr, out, steps);
        first = false;

        for (const auto& e : out)
            r.midi.push_back ({ elapsed + e.sampleOffset, e });
        for (const auto& e : steps)
            r.steps.push_back (e);

        for (int i = 0; i < size; ++i)
        {
            r.beatAtSample.push_back (beat);
            beat += tempoAt (beat) / 60.0 / sampleRate;
        }
        elapsed += size;
    }

    seq::BlockInfo stop;
    stop.playing    = false;
    stop.sampleRate = sampleRate;
    stop.numSamples = size;
    seq::EventBuffer out;
    sequencer.process (stop, nullptr, out, steps);
    for (const auto& e : out)
        r.midi.push_back ({ elapsed + e.sampleOffset, e });

    return r;
}

void checkRamp (double fromBpm, double toBpm, int size, const seq::Sequence& sequence,
                double gateBeats)
{
    const auto r = runRamp (fromBpm, toBpm, size, sequence);

    CHECK_BALANCED (r.midi);

    // Every boundary played once, none skipped: sixteen beats of quarter-beat steps.
    CHECK (r.steps.size() >= 63 && r.steps.size() <= 65);
    for (size_t i = 1; i < r.steps.size(); ++i)
        CHECK_EQ (r.steps[i].index, r.steps[i - 1].index + 1);

    // Nothing was cut short by a flush: each note lasts its gate, give or take a
    // block of lateness. A flush would end notes at arbitrary points inside it.
    const double blockBeats = size / 44100.0 * std::max (fromBpm, toBpm) / 60.0;
    std::array<std::vector<long long>, 128> started;
    int checked = 0;

    for (const auto& t : r.midi)
    {
        const auto note = static_cast<size_t> (t.event.note);

        if (t.event.on)
        {
            started[note].push_back (t.sample);
        }
        else if (t.sample < static_cast<long long> (r.beatAtSample.size()))
        {
            REQUIRE (! started[note].empty());
            const double held = r.beatAtSample[static_cast<size_t> (t.sample)]
                              - r.beatAtSample[static_cast<size_t> (started[note].front())];
            started[note].erase (started[note].begin());

            CHECK (held >= gateBeats - 0.01);
            CHECK (held <= gateBeats + blockBeats + 0.01);
            ++checked;
        }
    }
    CHECK (checked > 50);
}

}

TEST (sequencer_a_tempo_ramp_is_not_a_jump)
{
    // Quarter-beat steps: plain, a chord with a phrased note, a rest.
    auto s = build (4.0, 2000.0, { { 60 }, { 62, N (65, 0.5) }, { 64, 67 }, {} });
    auto legato = build (4.0, 2000.0, { { 60, 64 }, { 60, 67 }, {} , { 62 } }, true);

    for (const int size : { 32, 512, 2048 })
    {
        const int before = check::failures();

        checkRamp (60.0, 180.0, size, *s, 0.25);
        checkRamp (180.0, 60.0, size, *s, 0.25);

        // Legato notes have no gate; they only have to stay balanced and on the grid.
        for (const auto& ramp : { std::make_pair (60.0, 180.0), std::make_pair (180.0, 60.0) })
        {
            const auto r = runRamp (ramp.first, ramp.second, size, *legato);
            CHECK_BALANCED (r.midi);
            CHECK (r.steps.size() >= 63 && r.steps.size() <= 65);
            for (size_t i = 1; i < r.steps.size(); ++i)
                CHECK_EQ (r.steps[i].index, r.steps[i - 1].index + 1);
        }

        if (check::failures() != before)
            std::printf ("    ^ with blocks of %d samples\n", size);
    }
}

TEST (sequencer_a_boundary_in_a_small_gap_between_blocks_is_late_not_lost)
{
    // A host that integrates a tempo ramp starts a block slightly after where
    // the last one was extrapolated to end. A boundary in that gap must still
    // play, at the start of the block.
    seq::StepSequencer sequencer;
    seq::StepEventBuffer steps;
    seq::EventBuffer out;

    auto s = build (1.0, 100.0, { { 60 }, { 62 }, { 64 }, { 65 }, { 67 } });

    seq::BlockInfo a;
    a.beatPos    = 3.5;
    a.sampleRate = 65536.0;
    a.numSamples = 16000;   // ends at 3.988
    a.playing    = true;
    sequencer.process (a, s.get(), out, steps);
    CHECK_EQ (steps.count, 0);

    auto b      = a;
    b.beatPos   = 4.0 + 0.002;   // the boundary at 4 lies in the gap, which is under 1/64 beat
    b.numSamples = 512;
    sequencer.process (b, nullptr, out, steps);

    REQUIRE (steps.count == 1);
    CHECK_EQ (steps[0].index, 4);
    REQUIRE (out.count >= 1);
    CHECK (is (out[0], true, 67));
    CHECK_EQ (out[0].sampleOffset, 0);
}

TEST (sequencer_an_absurd_rate_cannot_hold_up_the_audio_thread)
{
    for (const double rate : { 1.0e9, 1.0e15, 1.0e300 })
    {
        auto host = Host::grid();
        auto s    = build (rate, 100.0, { span (30, 48) });

        host.beatPos = 123.456;
        host.run (512, true, s.get());
        host.run (2048);

        CHECK (host.steps.count <= seq::kMaxStepEventsPerBlock);

        host.stop();
        CHECK_BALANCED (host.log);
    }
}

TEST (sequencer_loops_at_a_sample_rate_that_does_not_divide_the_beat_still_play_one_downbeat)
{
    for (const auto& style : kStyles)
        atBlockSizes ([&style] (int size)
        {
            // 44.1 kHz at 127 bpm: the wrap falls between samples.
            Host host;
            host.sampleRate = 44100.0;
            host.bpm        = 127.0;
            host.looping    = true;
            host.loopStart  = 1.0;
            host.loopEnd    = 5.0;
            host.loopStyle  = style.style;
            host.beatPos    = 1.0 + 37.3 / 44100.0 * 127.0 / 60.0;

            auto s = build (2.0, 1000.0, { { 60 }, { 62 }, { 64 }, { 65 }, { 67 }, { 69 }, { 71 }, { 72 } });

            const long long bar = static_cast<long long> (std::llround (4.0 * 44100.0 * 60.0 / 127.0));
            host.run (size, true, s.get());
            host.play (4 * bar, size);

            // Steps 2, 3, ... are numbered by the host beat: the loop start is step 2,
            // which is chord 2 (64), once per pass.
            const auto passes = static_cast<size_t> (host.elapsed / bar);
            CHECK_EQ (host.times (64, true).size(), passes);

            host.stop();
            CHECK_BALANCED (host.log);
        });
}

TEST (sequencer_a_loop_end_on_a_triplet_position_does_not_play_the_step_that_belongs_to_the_next_pass)
{
    // The host's double for a third of a beat is an ulp above the sequencer's
    // boundary of the step there (10 * (1 / 3) is below 10 / 3), so the step at
    // the loop end is a hair before it.
    struct Loop
    {
        double start, end;
        int    first, last;   // the steps whose boundaries are inside the loop
    };

    const Loop loops[] = { { 1.0, 10.0 / 3.0, 3, 9 }, { 4.0 / 3.0, 10.0 / 3.0, 4, 9 },
                           { 0.0, 5.0 / 3.0, 0, 4 },  { 1.0, 7.0 / 3.0, 3, 6 } };

    for (const auto& style : kStyles)
        for (const auto& loop : loops)
            atBlockSizes ([&style, &loop] (int size)
            {
                Host host;
                host.sampleRate = 48000.0;
                host.bpm        = 117.0;
                host.looping    = true;
                host.loopStart  = loop.start;
                host.loopEnd    = loop.end;
                host.loopStyle  = style.style;
                host.beatPos    = loop.start;

                auto s = build (3.0, 100.0, { { 60 } });

                const auto pass = static_cast<long long> ((loop.end - loop.start) * 48000.0 * 60.0 / 117.0);
                host.run (size, true, s.get());
                host.play (5 * pass / 2, size);   // two and a half passes

                std::vector<int> indices;
                for (const auto& r : host.stepLog)
                    indices.push_back (r.event.index);

                REQUIRE (indices.size() > static_cast<size_t> (2 * (loop.last - loop.first + 1)));
                CHECK_EQ (indices.front(), loop.first);

                for (size_t i = 0; i < indices.size(); ++i)
                {
                    CHECK (indices[i] >= loop.first && indices[i] <= loop.last);

                    if (i > 0)
                        CHECK_EQ (indices[i], indices[i - 1] == loop.last ? loop.first : indices[i - 1] + 1);
                }

                host.stop();
                CHECK_BALANCED (host.log);
            });
}
