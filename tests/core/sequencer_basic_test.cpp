#include "sequencer_support.h"

// Hand-written cases for the obvious behaviour. Block positions are chosen so
// that sample offsets land at x.5, away from floating-point rounding; the few
// that cannot are compared with a one-sample tolerance. The timing tests that
// run at several block sizes use the exact-in-binary grid host instead.
using namespace seqtest;

TEST (sequencer_note_on_lands_on_the_boundary_sample)
{
    Host host;
    auto s = build (1.0, 100.0, { { 60 } });

    // The boundary at beat 1 falls 100.5 samples into the block.
    host.beatPos = 1.0 - 100.5 / 24000.0;
    const auto events = host.run (512, true, s.get());

    REQUIRE (events.size() == 1);
    CHECK (is (events[0], true, 60));
    CHECK_EQ (events[0].sampleOffset, 100);
}

TEST (sequencer_note_off_lands_one_gate_later)
{
    Host host;
    auto s = build (1.0, 100.0, { { 60 } });   // 100 ms = 4800 samples

    host.beatPos = 1.0 - 100.5 / 24000.0;
    const auto first = host.run (512, true, s.get());

    REQUIRE (first.size() == 1);
    CHECK (is (first[0], true, 60));
    CHECK_EQ (first[0].sampleOffset, 100);

    // Note-offs are due 4800 samples after the note-on: 4388 samples into the
    // block that follows the 512-sample one.
    const auto second = host.run (8192);

    REQUIRE (second.size() == 1);
    CHECK (is (second[0], false, 60));
    CHECK_EQ (second[0].sampleOffset, 4388);
}

TEST (sequencer_note_off_in_a_later_block_keeps_its_time)
{
    Host host;
    auto s = build (1.0, 100.0, { { 60 } });

    auto first = host.run (2400, true, s.get());   // boundary at 0, off due at sample 4800
    REQUIRE (first.size() == 1);
    CHECK (is (first[0], true, 60));

    auto second = host.run (2400);                  // off at sample 2400 of the run = 0 of this block
    CHECK (second.empty());

    auto third = host.run (2400);
    REQUIRE (third.size() == 1);
    CHECK (is (third[0], false, 60));
}

TEST (sequencer_gate_is_capped_at_one_step_and_off_precedes_on)
{
    Host host;
    auto s = build (2.0, 5000.0, { { 60 } });   // a step is 12000 samples

    const auto first = host.run (6000, true, s.get());
    REQUIRE (first.size() == 1);
    CHECK (is (first[0], true, 60));
    CHECK_EQ (first[0].sampleOffset, 0);

    // The next boundary is 6000 samples into this block. The capped note ends
    // there, and only then does the step restart on the same sample.
    const auto second = host.run (10000);

    REQUIRE (second.size() == 2);
    CHECK (is (second[0], false, 60));
    CHECK (is (second[1], true, 60));
    CHECK (near (second[0].sampleOffset, 6000));
    CHECK_EQ (second[0].sampleOffset, second[1].sampleOffset);
}

TEST (sequencer_chord_notes_come_out_in_order)
{
    Host host;
    auto s = build (1.0, 100.0, { { 60, 64, 67 } });

    const auto events = host.run (1000, true, s.get());

    REQUIRE (events.size() == 3);
    CHECK (is (events[0], true, 60));
    CHECK (is (events[1], true, 64));
    CHECK (is (events[2], true, 67));
}

TEST (sequencer_cycles_through_the_steps)
{
    Host host;
    auto s = build (1.0, 50.0, { { 60 }, { 62 }, {} });

    std::vector<int> played;
    for (int i = 0; i < 6; ++i)
        for (const auto& e : host.run (24000, true, i == 0 ? s.get() : nullptr))
            if (e.on)
                played.push_back (e.note);

    const std::vector<int> expected { 60, 62, 60, 62 };
    CHECK (played == expected);
}

TEST (sequencer_phrased_note_fires_later_in_its_step)
{
    Host host;
    auto s = build (1.0, 100.0, { { N (60, 0.5) } });

    const auto events = host.run (36000, true, s.get());   // 1.5 beats

    REQUIRE (events.size() == 1);
    CHECK (is (events[0], true, 60));
    CHECK (near (events[0].sampleOffset, 12000));
}

TEST (sequencer_stop_flushes_what_is_sounding)
{
    Host host;
    auto s = build (1.0, 2000.0, { { 60, 64 } });

    host.run (4800, true, s.get());                  // both on, off a beat away

    const auto stopped = host.run (512, false);
    REQUIRE (stopped.size() == 2);
    CHECK (is (stopped[0], false, 60));
    CHECK (is (stopped[1], false, 64));
    CHECK_EQ (stopped[0].sampleOffset, 0);
    CHECK_EQ (stopped[1].sampleOffset, 0);

    CHECK (host.run (512, false).empty());
}

TEST (sequencer_stop_releases_legato_notes_and_drops_phrased_ones)
{
    Host host;
    auto legato = build (1.0, 100.0, { { 60, 64 } }, true);

    const auto started = host.run (1000, true, legato.get());
    REQUIRE (started.size() == 2);

    const auto stopped = host.run (512, false);
    REQUIRE (stopped.size() == 2);
    CHECK (is (stopped[0], false, 60));
    CHECK (is (stopped[1], false, 64));

    // A phrased note that has not fired yet dies with the stop.
    Host phrased;
    auto s = build (1.0, 100.0, { { N (60, 0.9) } });
    CHECK (phrased.run (1000, true, s.get()).empty());
    CHECK (phrased.run (512, false).empty());
}

TEST (sequencer_legato_sends_only_the_difference)
{
    Host host;
    auto s = build (1.0, 100.0, { { 60, 64 }, { 60, 67 } }, true);

    const auto events = host.run (36000, true, s.get());

    REQUIRE (events.size() == 4);
    CHECK (is (events[0], true, 60));
    CHECK (is (events[1], true, 64));
    CHECK (is (events[2], false, 64));
    CHECK (is (events[3], true, 67));
    CHECK_EQ (events[0].sampleOffset, 0);
    CHECK (near (events[2].sampleOffset, 24000));
    CHECK_EQ (events[2].sampleOffset, events[3].sampleOffset);
}

TEST (sequencer_probability_zero_never_plays_and_one_always_does)
{
    Host host;
    auto s = build (4.0, 20.0, { { N (60, 0.0, 0.0f), N (62, 0.0, 1.0f) } });

    int sixty = 0, sixtyTwo = 0;
    for (int i = 0; i < 40; ++i)
        for (const auto& e : host.run (6000, true, i == 0 ? s.get() : nullptr))
            if (e.on)
                (e.note == 60 ? sixty : sixtyTwo) += 1;

    CHECK_EQ (sixty, 0);
    CHECK (sixtyTwo > 30);
}

TEST (sequencer_probability_rolls_are_repeatable_per_seed)
{
    auto s = build (1.0, 20.0, { { N (60, 0.0, 0.5f) } });

    auto play = [&s] (uint64_t seed)
    {
        Host host;
        host.sequencer->setSeed (seed);

        std::vector<int> hits;   // block indices whose step played
        for (int i = 0; i < 2000; ++i)
            for (const auto& e : host.run (24000, true, i == 0 ? s.get() : nullptr))
                if (e.on)
                    hits.push_back (i);
        return hits;
    };

    const auto a = play (42), b = play (42), c = play (43);

    CHECK (a == b);
    CHECK (a != c);
    CHECK (a.size() > 850 && a.size() < 1150);   // about half of 2000
}

TEST (sequencer_adopts_a_sequence_posted_while_stopped)
{
    Host host;
    auto s = build (4.0, 100.0, { { 60 }, { 62 } });

    CHECK (host.run (512, false, s.get()).empty());
    CHECK_EQ (host.sequencer->sequence().numSteps, 2);
    CHECK_EQ (host.sequencer->sequence().stepsPerBeat, 4.0);

    const auto events = host.run (512);   // play: the very first block already sounds
    REQUIRE (events.size() >= 1);
    CHECK (is (events[0], true, 60));
    CHECK_EQ (events[0].sampleOffset, 0);
}

TEST (sequencer_edit_strikes_an_added_note_immediately)
{
    Host host;
    auto before = build (1.0, 2000.0, { { 60 } });
    auto after  = build (1.0, 2000.0, { { 60, 64 } });

    host.run (4800, true, before.get());                    // 0.2 beat into the step
    const auto events = host.run (512, true, after.get());

    REQUIRE (events.size() == 1);                           // 60 is not retriggered
    CHECK (is (events[0], true, 64));
    CHECK_EQ (events[0].sampleOffset, 0);

    // The added note ends with the step, on the grid.
    const auto rest = host.run (24000);
    REQUIRE (rest.size() >= 2);
    CHECK (is (rest[0], false, 60));
    CHECK (is (rest[1], false, 64));
}

TEST (sequencer_edit_silences_a_removed_note_immediately)
{
    Host host;
    auto before = build (1.0, 2000.0, { { 60, 64 } });
    auto after  = build (1.0, 2000.0, { { 64 } });

    host.run (4800, true, before.get());
    const auto events = host.run (512, true, after.get());

    REQUIRE (events.size() == 1);
    CHECK (is (events[0], false, 60));
    CHECK_EQ (events[0].sampleOffset, 0);
}

TEST (sequencer_clearing_the_sequence_still_ends_sounding_notes)
{
    Host host;
    auto s     = build (1.0, 2000.0, { { 60 } });
    auto empty = build (1.0, 2000.0, {});

    host.run (4800, true, s.get());
    CHECK (host.run (512, true, empty.get()).empty());

    const auto events = host.run (24000);
    REQUIRE (events.size() == 1);
    CHECK (is (events[0], false, 60));
}

TEST (sequencer_clearing_a_legato_sequence_releases_its_notes)
{
    Host host;
    auto s     = build (1.0, 100.0, { { 60, 64 } }, true);
    auto empty = build (1.0, 100.0, {}, true);

    host.run (1000, true, s.get());
    const auto events = host.run (512, true, empty.get());

    REQUIRE (events.size() == 2);
    CHECK (is (events[0], false, 60));
    CHECK (is (events[1], false, 64));
    CHECK_EQ (events[0].sampleOffset, 0);
}

TEST (sequencer_flush_ends_everything_and_is_idempotent)
{
    Host host;
    auto s = build (1.0, 2000.0, { { 60, 64 } });
    host.run (4800, true, s.get());

    seq::EventBuffer out;
    host.sequencer->flush (out, 7);

    REQUIRE (out.count == 2);
    CHECK (is (out[0], false, 60));
    CHECK (is (out[1], false, 64));
    CHECK_EQ (out[0].sampleOffset, 7);

    out.clear();
    host.sequencer->flush (out, 7);
    CHECK_EQ (out.count, 0);

    CHECK_EQ (host.sequencer->sequence().numSteps, 1);   // the sequence itself is kept
}


TEST (sequencer_count_in_steps_index_the_cycle_from_below_zero)
{
    atBlockSizes ([] (int size)
    {
        // Four beats from three beats before zero: the steps are -3, -2, -1 and
        // 0, and a negative step still lands on the right chord of the cycle.
        auto host = Host::grid();
        auto s    = build (1.0, 100.0, { { 60 }, { 62 }, { 64 } });

        host.beatPos = -3.0;
        host.run (size, true, s.get());
        host.play (4 * 32768 - size, size);

        CHECK (host.times (60, true) == (std::vector<long long> { 0, 98304 }));
        CHECK (host.times (62, true) == (std::vector<long long> { 32768 }));
        CHECK (host.times (64, true) == (std::vector<long long> { 65536 }));

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_count_in_steps_between_beats_are_found_too)
{
    auto host = Host::grid();
    auto s    = build (2.0, 100.0, { { 60 }, { 62 }, { 64 }, { 65 } });

    // Half a beat before zero is step -1, which is the last chord of four.
    host.beatPos = -0.5;
    host.run (32768 / 2 + 512, true, s.get());

    CHECK (host.times (65, true) == (std::vector<long long> { 0 }));
    CHECK (host.times (60, true) == (std::vector<long long> { 16384 }));
}

TEST (sequencer_gate_is_capped_at_exactly_one_step)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (4.0, 5000.0, { { 60 } });   // a step is 8192 samples; the gate asks for far more

        host.run (size, true, s.get());
        host.play (3 * 8192 - size, size);
        host.stop();

        const auto ons  = host.times (60, true);
        const auto offs = host.times (60, false);

        REQUIRE (ons.size() == 3);
        REQUIRE (offs.size() == 3);

        for (size_t i = 0; i < 3; ++i)
        {
            CHECK_EQ (ons[i], static_cast<long long> (i) * 8192);

            // The off is due on the next boundary; it may land on the last sample
            // of the block that ends there, but never later than the next on.
            if (i + 1 < 3)
            {
                CHECK (near (offs[i], ons[i] + 8192));
                CHECK (offs[i] <= ons[i + 1]);
            }
        }
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_probability_half_is_reported_in_the_step_events)
{
    auto s = build (4.0, 20.0, { { N (60, 0.0, 0.5f), N (62, 0.0, 1.0f), N (64, 0.0, 0.0f) } });

    auto play = [&s] (uint64_t seed)
    {
        auto host = std::make_unique<Host> (Host::grid());
        host->sequencer->setSeed (seed);

        for (int i = 0; i < 2000; ++i)   // one step per block, on its first sample
            host->run (8192, true, i == 0 ? s.get() : nullptr);
        return host;
    };

    const auto host = play (7);

    REQUIRE (host->stepLog.size() == 2000);

    int reported = 0;
    for (const auto& r : host->stepLog)
    {
        const auto& e = r.event;
        bool has60 = false;

        for (int i = 0; i < e.numPlayed; ++i)
        {
            has60 = has60 || e.played[static_cast<size_t> (i)] == 60;
            CHECK (e.played[static_cast<size_t> (i)] != 64);   // probability 0
        }

        CHECK (e.numPlayed == (has60 ? 2 : 1));
        CHECK_EQ (e.played[static_cast<size_t> (e.numPlayed - 1)], 62);   // probability 1, always
        reported += has60 ? 1 : 0;
    }

    // What was reported is what sounded.
    CHECK_EQ (static_cast<int> (host->times (60, true).size()), reported);
    CHECK_EQ (static_cast<int> (host->times (62, true).size()), 2000);
    CHECK_EQ (static_cast<int> (host->times (64, true).size()), 0);

    CHECK (reported > 900 && reported < 1100);   // about half of 2000

    // Same seed, same story; another seed, another one.
    CHECK (play (7)->times (60, true) == host->times (60, true));
    CHECK (play (8)->times (60, true) != host->times (60, true));
}

TEST (sequencer_phrased_notes_land_on_their_samples)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (1.0, 250.0, { { N (60, 0.25), N (62, 0.5), N (64, 0.75) } });   // gate: half a beat

        host.run (size, true, s.get());
        host.play (3 * 16384 - size, size);   // 1.5 beats

        // A step is 32768 samples, so the notes start 8192, 16384 and 24576
        // samples in, and each lasts 16384.
        REQUIRE (! host.times (64, true).empty());
        REQUIRE (! host.times (60, false).empty());
        REQUIRE (! host.times (62, false).empty());
        CHECK (host.times (60, true).front() == 8192);
        CHECK (host.times (62, true).front() == 16384);
        CHECK (host.times (64, true).front() == 24576);

        CHECK (near (host.times (60, false).front(), 8192 + 16384));
        CHECK (near (host.times (62, false).front(), 16384 + 16384));

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_edit_to_another_step_is_silent)
{
    atBlockSizes ([] (int size)
    {
        auto host   = Host::grid();
        auto before = build (1.0, 2000.0, { { 60 }, { 62 } });
        auto after  = build (1.0, 2000.0, { { 60 }, { 64 } });

        host.run (size, true, before.get());
        host.play (8192, size);

        CHECK (host.run (size, true, after.get()).empty());
    });
}

TEST (sequencer_edit_leaves_unchanged_notes_alone)
{
    auto host   = Host::grid();
    auto before = build (1.0, 2000.0, { { 60, 64 } });
    auto after  = build (1.0, 2000.0, { { 60, 64, 67 } });

    host.run (512, true, before.get());
    host.play (8192, 512);
    const auto events = host.run (512, true, after.get());

    REQUIRE (events.size() == 1);   // 67 only: 60 and 64 are neither stopped nor struck again
    CHECK (is (events[0], true, 67));
    CHECK_EQ (events[0].sampleOffset, 0);

    // A removed note goes, and the others carry on to their original note-offs.
    auto fewer = build (1.0, 2000.0, { { 64 } });
    const auto cut = host.run (512, true, fewer.get());

    REQUIRE (cut.size() == 2);
    CHECK (is (cut[0], false, 60));
    CHECK (is (cut[1], false, 67));

    host.run (32768);
    host.stop();
    CHECK (host.times (64, true).size() == 2);    // the original strike and the next step's
    CHECK (host.times (64, false).size() == 2);   // the first ends on the boundary, the second at the stop
    CHECK_BALANCED (host.log);
}

TEST (sequencer_edit_adding_a_phrased_note_fires_it_when_due)
{
    atBlockSizes ([] (int size)
    {
        auto host   = Host::grid();
        auto before = build (1.0, 250.0, { { 60 } });
        auto after  = build (1.0, 250.0, { { 60, N (64, 0.5) } });

        host.run (size, true, before.get());
        host.play (8192 - size, size);   // a quarter of the step

        CHECK (host.run (size, true, after.get()).empty());   // its moment is still ahead
        host.play (3 * 16384, size);

        REQUIRE (! host.times (64, true).empty());
        REQUIRE (! host.times (64, false).empty());
        CHECK (host.times (64, true).front() == 16384);
        CHECK (near (host.times (64, false).front(), 16384 + 16384));
    });
}

TEST (sequencer_edit_adding_a_note_whose_window_has_passed_does_not_strike_it)
{
    auto host   = Host::grid();
    auto before = build (1.0, 100.0, { { 60 } });             // the gate is 0.2 beat
    auto after  = build (1.0, 100.0, { { 60, 64 } });

    host.run (512, true, before.get());
    host.play (16384, 512);                                    // half a beat in

    CHECK (host.run (512, true, after.get()).empty());
    CHECK (host.times (64, true).empty());
}

TEST (sequencer_flush_leaves_nothing_pending)
{
    // Non-legato: a ringing note and a phrased one that has not fired.
    {
        Host host;
        auto s = build (1.0, 2000.0, { { 60, N (62, 0.5) } });
        host.run (4800, true, s.get());

        seq::EventBuffer out;
        host.sequencer->flush (out, 0);
        REQUIRE (out.count == 1);
        CHECK (is (out[0], false, 60));

        // The transport carries on from where it was: neither the note-off nor
        // the phrased note shows up later, only the next boundary does.
        CHECK (host.run (16000).empty());                      // up to 0.87 beat
        const auto next = host.run (8000);                     // across beat 1
        REQUIRE (next.size() >= 1);
        CHECK (is (next[0], true, 60));
    }

    // Legato: held notes are released and the full chord comes back at the next step.
    {
        Host host;
        auto s = build (1.0, 100.0, { { 60, 64 } }, true);
        host.run (1000, true, s.get());

        seq::EventBuffer out;
        host.sequencer->flush (out, 3);
        REQUIRE (out.count == 2);
        CHECK_EQ (out[0].sampleOffset, 3);

        CHECK (host.run (20000).empty());
        const auto next = host.run (4800);
        REQUIRE (next.size() == 2);
        CHECK (is (next[0], true, 60));
        CHECK (is (next[1], true, 64));
    }
}

TEST (sequencer_stopping_the_transport_flushes_every_kind_of_note)
{
    auto host = Host::grid();
    auto s    = build (4.0, 2000.0, { { 60, N (62, 0.5), 64 } });   // immediate, phrased, immediate

    host.run (512, true, s.get());
    host.play (3000, 512);   // 62 is still pending its phrase; 60 and 64 sound

    host.stop();
    CHECK_BALANCED (host.log);

    const auto ons = host.log.size();
    for (int i = 0; i < 64; ++i)   // stopped: nothing at all
        host.run (512, false);
    CHECK_EQ (host.log.size(), ons);
}

TEST (sequencer_balance_check_notices_what_it_should)
{
    auto timed = [] (long long sample, bool on, int note)
    {
        Timed t;
        t.sample = sample;
        t.event.note = static_cast<uint8_t> (note);
        t.event.on   = on;
        return t;
    };

    CHECK (unbalanced ({ timed (0, true, 60), timed (5, false, 60) }).empty());
    CHECK (unbalanced ({ timed (0, true, 60), timed (1, true, 60), timed (5, false, 60), timed (9, false, 60) }).empty());
    CHECK (! unbalanced ({ timed (0, true, 60) }).empty());                                   // never released
    CHECK (! unbalanced ({ timed (0, false, 60) }).empty());                                  // never started
    CHECK (! unbalanced ({ timed (0, true, 60), timed (5, false, 60), timed (6, false, 60) }).empty());
    CHECK (! unbalanced ({ timed (9, true, 60), timed (5, false, 60) }).empty());             // off before on in time
}
