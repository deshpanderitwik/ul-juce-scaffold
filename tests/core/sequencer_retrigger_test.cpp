#include "sequencer_support.h"

// A pitch that strikes again while its earlier instance is still sounding. The
// earlier instance has to end where the new note starts, and the new note then
// runs its own full gate. That fails in two ways:
//   - at 1/8T the note-off of a capped gate and the next trigger are the same
//     beat, but computed two ways they are two doubles an ulp apart, and the
//     truncation to samples can put the note-off a sample after the note-on;
//   - a note-off that is still pending when the same pitch strikes (a phrased
//     note that rings into the next step, a gate carried across a loop wrap
//     that is not a whole number of steps) lands part-way through the new note.
using namespace seqtest;

namespace
{

// The events of one pitch, in the order the host delivers them.
std::vector<Timed> eventsOf (const std::vector<Timed>& log, int note)
{
    std::vector<Timed> r;
    for (const auto& t : inTimeOrder (log))
        if (t.event.note == note)
            r.push_back (t);
    return r;
}

// Empty when the events of one pitch go on, off, on, off...: no note starts
// while the pitch is sounding and no note-off comes without a note.
std::string notAlternating (const std::vector<Timed>& events)
{
    char buf[128];

    for (size_t i = 0; i < events.size(); ++i)
    {
        const bool expectOn = i % 2 == 0;

        if (events[i].event.on != expectOn)
        {
            std::snprintf (buf, sizeof buf, "note-%s at sample %lld while %s", events[i].event.on ? "on" : "off",
                           events[i].sample, expectOn ? "off" : "sounding");
            return buf;
        }
    }
    return {};
}

// Empty when, besides alternating, every note-off falls on the sample of the
// note-on that follows it, or the sample before when the two are on either side
// of a block boundary (a note-off due where a block ends goes on its last
// sample): a pitch that strikes on every step with a gate of a whole step is
// ended by its next strike and by nothing else.
std::string notChained (const std::vector<Timed>& events)
{
    const auto why = notAlternating (events);
    char buf[128];

    if (! why.empty())
        return why;

    for (size_t i = 1; i + 1 < events.size(); i += 2)
    {
        const long long gap = events[i + 1].sample - events[i].sample;

        if (gap < 0 || gap > 1)
        {
            std::snprintf (buf, sizeof buf, "note-off at sample %lld, next note-on at %lld",
                           events[i].sample, events[i + 1].sample);
            return buf;
        }
    }
    return {};
}

// A host that reports the playhead as (samples so far) * (beats per sample)
// instead of adding up block lengths, which is what makes the arithmetic of a
// triplet land on a whole sample.
void playAtPositions (Host& host, long long samples, int size, const seq::Sequence* first)
{
    for (long long done = 0; done < samples; done += size)
    {
        host.beatPos = static_cast<double> (host.elapsed) * host.beatsPerSample();
        host.run (size, true, done == 0 ? first : nullptr);
    }
}

// 48 kHz at 120 bpm: a third of a beat is 8000 samples, a quarter of that 2000.
Host tripletHost()
{
    Host host;
    host.sampleRate = 48000.0;
    host.bpm        = 120.0;
    return host;
}

constexpr int kTripletStep = 8000;

}

// ---- the capped note-off is the next trigger -----------------------------------------

TEST (sequencer_a_capped_gate_at_1_8T_ends_on_the_sample_of_the_next_strike)
{
    atBlockSizes ([] (int size)
    {
        auto host = tripletHost();
        auto s    = build (3.0, 60000.0, { { 60, 64, 67 } });

        playAtPositions (host, 60 * 48000, size, s.get());

        for (const int note : { 60, 64, 67 })
        {
            const auto events = eventsOf (host.log, note);

            CHECK (events.size() > 300);
            CHECK_EQ (notChained (events), std::string());
        }
    });
}

TEST (sequencer_a_capped_gate_at_1_8T_ends_on_the_sample_of_the_next_strike_when_phrased)
{
    atBlockSizes ([] (int size)
    {
        // Every pitch keeps its own delay, so each is struck at the same place in
        // every step; a quarter and a half of a step are whole samples here.
        auto host = tripletHost();
        auto s    = build (3.0, 60000.0, { { N (60, 0.25), N (64, 0.5), N (67, 0.0) } });

        playAtPositions (host, 60 * 48000, size, s.get());

        for (const int note : { 60, 64, 67 })
        {
            const auto events = eventsOf (host.log, note);

            CHECK (events.size() > 300);
            CHECK_EQ (notChained (events), std::string());
        }
    });
}

namespace
{

// An edit posted part-way through a step adds a note to it; the note is
// struck (or scheduled) in the middle of the step and runs to the next boundary,
// where the same pitch strikes again.
void checkEditedNoteChains (double delay, int sampleIntoStep)
{
    int cut = 0;

    for (int step = 3; step < 60; ++step)
    {
        auto host   = tripletHost();
        auto before = build (3.0, 60000.0, { { 60 } }, false, 1);
        auto after  = build (3.0, 60000.0, { { N (60), N (64, delay) } }, false, 2);

        // The edit goes into the first block that starts at least `sampleIntoStep`
        // samples into the step; the blocks are not a divisor of the step, so
        // boundaries fall inside them.
        const long long editAt = static_cast<long long> (step) * kTripletStep + sampleIntoStep;

        playAtPositions (host, editAt, 512, before.get());
        host.beatPos = static_cast<double> (host.elapsed) * host.beatsPerSample();
        host.run (512, true, after.get());
        playAtPositions (host, 3 * kTripletStep, 512, nullptr);

        cut += notChained (eventsOf (host.log, 64)).empty() ? 0 : 1;
    }
    CHECK_EQ (cut, 0);
}

}

TEST (sequencer_a_note_added_mid_step_at_1_8T_ends_on_the_sample_of_the_next_strike)
{
    checkEditedNoteChains (0.0, 2000);
}

TEST (sequencer_a_phrased_note_added_mid_step_at_1_8T_ends_on_the_sample_of_the_next_strike)
{
    // The phrased moment (half way through the step) is still ahead when the
    // edit arrives a quarter of the way in.
    checkEditedNoteChains (0.5, 2000);

    // And already past: the note is struck at once.
    checkEditedNoteChains (0.25, 4000);
}

// ---- a pending note-off is cut at the retrigger --------------------------------------

TEST (sequencer_a_phrased_note_ringing_into_the_next_step_ends_where_its_pitch_strikes_again)
{
    atBlockSizes ([] (int size)
    {
        // Step 0's note starts half way through the step and lasts a step, so
        // it is still sounding when step 1 strikes the same pitch.
        auto host = Host::grid();
        auto s    = build (1.0, 2000.0, { { N (60, 0.5) }, { N (60) } });

        host.run (size, true, s.get());
        host.play (4 * 32768 - size, size);

        const auto events = eventsOf (host.log, 60);

        REQUIRE (events.size() >= 8);
        CHECK_EQ (events[0].sample, 16384);   // step 0, phrased
        CHECK (events[0].event.on);
        CHECK_EQ (events[1].sample, 32768);   // ended where step 1 strikes
        CHECK (! events[1].event.on);
        CHECK_EQ (events[2].sample, 32768);   // step 1's own note...
        CHECK (events[2].event.on);
        CHECK (near (events[3].sample, 65536));   // ...runs its whole step
        CHECK (! events[3].event.on);

        CHECK_EQ (notAlternating (events), std::string());

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_a_pitch_struck_before_its_pending_note_off_in_the_same_block_ends_at_the_strike)
{
    // 44.1 kHz at 120 bpm and six steps to the beat: a step is 3675 samples. An
    // even step plays pitch 60 three eighths of the way in and an odd step a
    // quarter of the way in, so the odd step strikes 459 samples before the even
    // step's note-off is due, and a block of 512 samples or more holds both.
    constexpr double step = 3675.0;

    atBlockSizes ([] (int size)
    {
        Host host;
        host.sampleRate = 44100.0;
        host.bpm        = 120.0;

        auto s = build (6.0, 60000.0, { { N (62, 0.125), N (60, 0.375) }, { N (60, 0.25) } });

        host.run (size, true, s.get());
        host.play (40 * 3675 - size, size);

        const auto events = eventsOf (host.log, 60);

        REQUIRE (events.size() >= 60);
        const auto why = notAlternating (events);
        CHECK_EQ (why, std::string());
        if (! why.empty())
            return;

        // Every note ends at the strike of the odd step after it: the even step's
        // by the retrigger, the odd step's by its own gate.
        for (size_t k = 0; k < 30; ++k)
        {
            const double start = static_cast<double> (k) * step + (k % 2 == 0 ? 1378.125 : 918.75);
            const double end   = static_cast<double> (k + 1) * step + 918.75;

            CHECK (events[2 * k].event.on);
            CHECK (near (events[2 * k].sample, std::llround (start)));
            CHECK (! events[2 * k + 1].event.on);
            CHECK (near (events[2 * k + 1].sample, std::llround (end)));
        }
    });
}

TEST (sequencer_a_phrased_note_due_before_a_strike_of_its_pitch_in_the_same_block_ends_at_the_strike)
{
    // 48 kHz at 120 bpm and twelve steps to the beat: a step is 2000 samples.
    // Step 0 plays pitch 60 a quarter of a step in and step 1 plays it on the
    // boundary, so a block that holds the boundary of step 1 also holds the
    // phrased note that has to end there.
    constexpr double step = 2000.0;

    atBlockSizes ([] (int size)
    {
        Host host;
        host.sampleRate = 48000.0;
        host.bpm        = 120.0;

        auto s = build (12.0, 60000.0, { { N (60, 0.25) }, { N (60) } });

        host.run (size, true, s.get());
        host.play (40 * 2000 - size, size);

        const auto events = eventsOf (host.log, 60);

        REQUIRE (events.size() >= 60);
        const auto why = notAlternating (events);
        CHECK_EQ (why, std::string());
        if (! why.empty())
            return;

        for (size_t k = 0; k < 30; ++k)
        {
            // The phrased note runs to the boundary of the next step, and so
            // does the one struck on a boundary.
            const double start = static_cast<double> (k) * step + (k % 2 == 0 ? 500.0 : 0.0);
            const double end   = static_cast<double> (k + 1) * step;

            CHECK (events[2 * k].event.on);
            CHECK (near (events[2 * k].sample, std::llround (start)));
            CHECK (! events[2 * k + 1].event.on);
            CHECK (near (events[2 * k + 1].sample, std::llround (end)));
        }
    });
}

TEST (sequencer_a_gate_carried_across_the_wrap_ends_where_the_loop_start_strikes_the_same_pitch)
{
    // Eight steps of 12000 samples at 48 kHz and 120 bpm in a loop of 3.75
    // beats: the last step is half a step before the loop end, and its note
    // lasts a step, so it is still on when the loop start strikes the same
    // pitch.
    for (const auto style : { LoopStyle::Unsplit, LoopStyle::Split })
        atBlockSizes ([style] (int size)
        {
            Host host;
            host.sampleRate = 48000.0;
            host.bpm        = 120.0;
            host.looping    = true;
            host.loopStart  = 0.0;
            host.loopEnd    = 3.75;
            host.loopStyle  = style;

            auto s = build (2.0, 60000.0, { { 60 } });

            constexpr long long pass = 90000;
            host.run (size, true, s.get());
            host.play (4 * pass - size, size);

            const auto events = eventsOf (host.log, 60);

            CHECK_EQ (notChained (events), std::string());

            // The downbeat of each pass lasts its whole step.
            int downbeats = 0;
            for (size_t i = 0; i + 1 < events.size(); ++i)
            {
                const long long into = events[i].sample % pass;

                if (events[i].event.on && (into <= 1 || into >= pass - 1))
                {
                    CHECK (near (events[i + 1].sample - events[i].sample, 12000));
                    ++downbeats;
                }
            }
            CHECK (downbeats >= 3);
        });
}
