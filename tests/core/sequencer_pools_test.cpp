#include "sequencer_support.h"

// The pending note-off and phrased note-on pools hold 128 each. When they run
// out, the sequencer ends the longest-sounding note early or drops a note that
// has not sounded; a note-off is never lost.
using namespace seqtest;

namespace
{

// 2048 samples a step on the grid host.
constexpr double kFastRate = 16.0;

std::vector<seq::MidiEvent> eventsAt (const std::vector<seq::MidiEvent>& events, int sample)
{
    std::vector<seq::MidiEvent> r;
    for (const auto& e : events)
        if (e.sampleOffset == sample)
            r.push_back (e);
    return r;
}

}

TEST (sequencer_a_full_note_off_pool_ends_the_oldest_note_where_the_new_one_starts)
{
    auto host = Host::grid();
    auto s    = build (kFastRate, 2000.0, { span (30, 48) });   // a 48-note chord on every step

    // Four steps in one block: 192 notes against a pool of 128.
    const auto events = host.run (8192, true, s.get());

    CHECK_EQ (host.steps.count, 4);

    int ons = 0, offs = 0;
    for (const auto& e : events)
        (e.on ? ons : offs) += 1;
    CHECK_EQ (ons, 192);
    CHECK_EQ (offs, 64);   // one for each note that did not fit

    // Step 2: 32 notes fit, then each of the last 16 is preceded by the note-off
    // of the oldest note, which belongs to step 0.
    const auto atStep2 = eventsAt (events, 4096);
    REQUIRE (atStep2.size() == 32 + 32);
    for (int i = 0; i < 32; ++i)
        CHECK (is (atStep2[static_cast<size_t> (i)], true, 30 + i));
    for (int i = 0; i < 16; ++i)
    {
        CHECK (is (atStep2[static_cast<size_t> (32 + 2 * i)], false, 30 + i));
        CHECK (is (atStep2[static_cast<size_t> (33 + 2 * i)], true, 62 + i));
    }

    // Step 3: all 48 evict, oldest first: what is left of step 0, then step 1.
    const auto atStep3 = eventsAt (events, 6144);
    REQUIRE (atStep3.size() == 96);
    for (int i = 0; i < 48; ++i)
    {
        const int oldest = i < 32 ? 46 + i : 30 + (i - 32);
        CHECK (is (atStep3[static_cast<size_t> (2 * i)], false, oldest));
        CHECK (is (atStep3[static_cast<size_t> (2 * i + 1)], true, 30 + i));
    }

    // Nothing is lost: the other 128 end at their own time or at the stop.
    host.play (3 * 2048, 2048);
    host.stop();
    CHECK_BALANCED (host.log);
    CHECK_EQ (mostSounding (host.log), seq::kMaxPending);
}

TEST (sequencer_the_note_off_pool_holds_up_at_every_block_size)
{
    atBlockSizes ([] (int size)
    {
        // About three and a third steps to a block, whatever the block size.
        auto host = Host::grid();
        auto s    = build (32768.0 * 3.3 / size, 2000.0, { span (30, 48), span (40, 48) });

        host.run (size, true, s.get());
        host.play (300 * size, size);
        host.stop();

        CHECK_BALANCED (host.log);
        CHECK_EQ (mostSounding (host.log), seq::kMaxPending);
    });
}

TEST (sequencer_a_full_phrased_pool_drops_the_new_phrased_notes)
{
    auto host = Host::grid();
    auto s    = build (kFastRate, 2000.0, { span (30, 48, 0.875) });   // all 48 notes phrased

    // Pending phrased notes: 48 after step 0, 96 after step 1, 128 after step 2
    // (16 of its notes dropped), and step 3's are all dropped.
    const auto events = host.run (8192, true, s.get());

    REQUIRE (host.steps.count == 4);
    for (int i = 0; i < 4; ++i)
        CHECK_EQ (host.steps[i].numPlayed, 48);   // they passed the dice, even those that were dropped

    int ons = 0;
    for (const auto& e : events)
    {
        CHECK (e.on);
        ons += 1;
    }
    CHECK_EQ (ons, 128);

    CHECK_EQ (eventsAt (events, 1792).size(), 48u);   // step 0 + 0.875 of 2048
    CHECK_EQ (eventsAt (events, 3840).size(), 48u);
    CHECK_EQ (eventsAt (events, 5888).size(), 32u);
    CHECK_EQ (eventsAt (events, 7936).size(), 0u);

    host.play (3 * 2048, 2048);
    host.stop();
    CHECK_BALANCED (host.log);
}

TEST (sequencer_a_pool_never_ends_a_note_before_it_has_started)
{
    // Step 0 has only phrased notes, due 256 samples in. Steps 1 to 3 fill the
    // pool with notes that start later than that, so there is no note that has
    // already started which could make room: the phrased ones are dropped
    // rather than ending notes that have not begun.
    auto host = Host::grid();
    auto s    = build (kFastRate, 2000.0,
                       { span (70, 8, 0.125), span (30, 40), span (30, 40), span (30, 40), span (30, 40) });

    const auto events = host.run (8192 + 2048, true, s.get());   // five steps

    for (const auto& e : events)
        CHECK (! (e.on && e.note >= 70 && e.note <= 77 && e.sampleOffset == 256));

    host.play (4 * 2048, 2048);
    host.stop();
    CHECK_BALANCED (host.log);
    CHECK (mostSounding (host.log) <= seq::kMaxPending);
}

TEST (sequencer_a_pool_with_both_kinds_of_note_stays_balanced)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        host.sequencer->setSeed (3);

        Chord mixed;
        for (int i = 0; i < 48; ++i)
            mixed.emplace_back (30 + i, i % 3 == 0 ? 0.0 : (i % 3 == 1 ? 0.25 : 0.9), i % 5 == 0 ? 0.5f : 1.0f);

        auto s = build (32768.0 * 2.7 / size, 800.0, { mixed, span (35, 48, 0.6) });

        host.run (size, true, s.get());
        host.play (200 * size, size);
        host.stop();

        CHECK_BALANCED (host.log);
        CHECK (mostSounding (host.log) <= seq::kMaxPending);
    });
}

TEST (sequencer_a_full_output_buffer_loses_no_note_off)
{
    // So many steps in each 32-sample block that a block's events do not fit.
    for (const bool legato : { false, true })
    {
        auto host = Host::grid();
        auto s    = build (40000.0, 2000.0, { span (0, 48), span (60, 48) }, legato);   // legato swaps all 48 each step

        bool saturated = false;

        host.run (32, true, s.get());
        for (int i = 0; i < 400; ++i)
        {
            // A note that would not leave room for its own note-off is not started,
            // so a block can stop one or two events short of the capacity.
            saturated = saturated || static_cast<int> (host.run (32).size()) >= seq::kMaxEventsPerBlock - 2;
            CHECK (host.steps.count <= seq::kMaxStepEventsPerBlock);
        }
        CHECK (saturated);

        host.stop();
        CHECK_BALANCED (host.log);
        CHECK (mostSounding (host.log) <= (legato ? seq::kMaxNotesPerStep : seq::kMaxPending));
    }
}
