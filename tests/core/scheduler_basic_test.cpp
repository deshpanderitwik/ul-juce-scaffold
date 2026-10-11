#include "../check.h"
#include "NoteScheduler.h"

#include <vector>

// The scheduler is driven the way the processor drives it: per block, handle()
// for each queued event, then advance() once. The harness keeps a running
// sample clock so events can be checked against where they land in time.
namespace
{
    constexpr double kRate  = 48000.0;
    constexpr int    kBlock = 512;

    struct Logged
    {
        long long time;   // samples since the harness started
        int  channel;
        int  note;
        int  velocity;
        bool on;
    };

    struct Harness
    {
        seq::NoteScheduler scheduler;
        std::vector<Logged> log;
        long long blockStart = 0;
        seq::EventBuffer out;

        Harness() { scheduler.prepare (kRate); }

        void collect()
        {
            for (const auto& e : out)
                log.push_back ({ blockStart + e.sampleOffset, e.channel, e.note, e.velocity, e.on });
            out.clear();
        }

        // One block: the events arrive at its start, then time advances.
        void block (const std::vector<seq::ImmediateEvent>& events = {}, int numSamples = kBlock)
        {
            out.clear();
            for (const auto& e : events)
                scheduler.handle (e, out);
            scheduler.advance (numSamples, out);
            collect();
            blockStart += numSamples;
        }

        void blocks (int count)
        {
            for (int i = 0; i < count; ++i)
                block();
        }

        int count (bool on, int note, int channel = 1) const
        {
            int n = 0;
            for (const auto& l : log)
                n += (l.on == on && l.note == note && l.channel == channel) ? 1 : 0;
            return n;
        }

        const Logged* find (bool on, int note, int channel = 1, int nth = 0) const
        {
            for (const auto& l : log)
                if (l.on == on && l.note == note && l.channel == channel && nth-- == 0)
                    return &l;
            return nullptr;
        }
    };

    seq::ImmediateEvent ev (seq::ImmediateEvent::Type type, int note, int velocity = 100,
                            int channel = 1, float durationMs = 0.0f)
    {
        seq::ImmediateEvent e;
        e.type       = type;
        e.note       = static_cast<uint8_t> (note);
        e.velocity   = static_cast<uint8_t> (velocity);
        e.channel    = static_cast<uint8_t> (channel);
        e.durationMs = durationMs;
        return e;
    }

    seq::ImmediateEvent noteOn (int note, int velocity = 100, int channel = 1)
    {
        return ev (seq::ImmediateEvent::NoteOn, note, velocity, channel);
    }

    seq::ImmediateEvent noteOff (int note, int channel = 1)
    {
        return ev (seq::ImmediateEvent::NoteOff, note, 0, channel);
    }

    seq::ImmediateEvent gated (int note, float ms, int velocity = 100, int channel = 1)
    {
        return ev (seq::ImmediateEvent::Note, note, velocity, channel, ms);
    }

    seq::ImmediateEvent allOff()
    {
        return ev (seq::ImmediateEvent::AllNotesOff, 0, 0);
    }
}

TEST (scheduler_starts_empty)
{
    Harness h;
    CHECK (! h.scheduler.anyHeld());
    h.blocks (4);
    CHECK_EQ (h.log.size(), size_t (0));
}

TEST (scheduler_note_on_then_off)
{
    Harness h;
    h.block ({ noteOn (60, 90, 3) });
    REQUIRE (h.log.size() == 1);
    CHECK (h.log[0].on);
    CHECK_EQ (h.log[0].note, 60);
    CHECK_EQ (h.log[0].velocity, 90);
    CHECK_EQ (h.log[0].channel, 3);
    CHECK_EQ (h.log[0].time, 0LL);
    CHECK (h.scheduler.anyHeld());

    // A held note has no gate, however long it stays.
    h.blocks (500);
    CHECK_EQ (h.log.size(), size_t (1));

    h.block ({ noteOff (60, 3) });
    REQUIRE (h.log.size() == 2);
    CHECK (! h.log[1].on);
    CHECK_EQ (h.log[1].channel, 3);
    CHECK_EQ (h.log[1].velocity, 0);
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_note_off_for_a_note_that_is_not_on_does_nothing)
{
    Harness h;
    h.block ({ noteOff (60) });
    CHECK_EQ (h.log.size(), size_t (0));

    // The same pitch on another channel is a different note.
    h.block ({ noteOn (60, 100, 2), noteOff (60, 1) });
    CHECK_EQ (h.log.size(), size_t (1));
    CHECK (h.scheduler.anyHeld());

    // And so is a second off for a note that has already ended.
    h.block ({ noteOff (60, 2), noteOff (60, 2) });
    CHECK_EQ (h.log.size(), size_t (2));
}

TEST (scheduler_retrigger_emits_off_then_on)
{
    Harness h;
    h.block ({ noteOn (60) });
    h.block ({ noteOn (60, 70) });

    REQUIRE (h.log.size() == 3);
    CHECK (h.log[0].on);
    CHECK (! h.log[1].on);
    CHECK (h.log[2].on);
    CHECK_EQ (h.log[2].velocity, 70);
    CHECK_EQ (h.log[1].time, h.log[2].time);

    // Still a single held note: one off ends it.
    h.block ({ noteOff (60) });
    CHECK_EQ (h.log.size(), size_t (4));
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_retrigger_within_one_block_keeps_order)
{
    Harness h;
    h.block ({ noteOn (60), noteOn (60), noteOn (60) });

    // on, off, on, off, on
    REQUIRE (h.log.size() == 5);
    for (size_t i = 0; i < h.log.size(); ++i)
        CHECK_EQ (h.log[i].on, i % 2 == 0);
}

TEST (scheduler_gated_note_ends_at_the_right_sample)
{
    Harness h;
    h.block ({ gated (67, 200.0f, 90) });   // 9600 samples

    for (int i = 0; i < 40; ++i)
        h.block();

    REQUIRE (h.log.size() == 2);
    CHECK (h.log[0].on);
    CHECK_EQ (h.log[0].time, 0LL);
    CHECK_EQ (h.log[0].velocity, 90);
    CHECK (! h.log[1].on);
    CHECK_EQ (h.log[1].time, 9600LL);
    CHECK_EQ (h.log[1].note, 67);
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_gate_shorter_than_a_block_yields_on_then_off_in_that_block)
{
    Harness h;
    h.block ({ gated (60, 1.0f) });   // 48 samples

    REQUIRE (h.log.size() == 2);
    CHECK (h.log[0].on);
    CHECK_EQ (h.log[0].time, 0LL);
    CHECK (! h.log[1].on);
    CHECK_EQ (h.log[1].time, 48LL);
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_zero_or_negative_gate_still_ends_after_it_starts)
{
    Harness h;
    h.block ({ gated (60, 0.0f), gated (61, -5.0f) });

    REQUIRE (h.log.size() == 4);
    CHECK (h.log[0].on && h.log[1].on);
    CHECK (! h.log[2].on && ! h.log[3].on);
    CHECK (h.log[2].time > 0);
    CHECK (h.log[3].time > 0);
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_gate_of_exactly_one_block_ends_at_the_start_of_the_next)
{
    Harness h;
    h.block ({ gated (60, 512.0f * 1000.0f / 48000.0f) });
    CHECK_EQ (h.log.size(), size_t (1));
    h.block();

    REQUIRE (h.log.size() == 2);
    CHECK_EQ (h.log[1].time, 512LL);
    CHECK (! h.log[1].on);
}

TEST (scheduler_gate_follows_the_block_size_the_host_uses)
{
    Harness h;
    h.block ({ gated (60, 100.0f) }, 64);   // 4800 samples

    for (int i = 0; i < 100; ++i)
        h.block ({}, 64);

    const auto* off = h.find (false, 60);
    REQUIRE (off != nullptr);
    CHECK_EQ (off->time, 4800LL);
}

TEST (scheduler_retrigger_replaces_the_running_gate)
{
    Harness h;
    h.block ({ gated (60, 200.0f) });   // would end at 9600
    for (int i = 0; i < 10; ++i)
        h.block();

    const long long retriggerAt = h.blockStart;   // 11 blocks in
    h.block ({ gated (60, 200.0f) });   // ends 9600 after the retrigger
    for (int i = 0; i < 60; ++i)
        h.block();

    CHECK_EQ (h.count (true, 60), 2);
    CHECK_EQ (h.count (false, 60), 2);

    // on, off(retrigger), on, off(gate): the first gate never fires on its own.
    REQUIRE (h.log.size() == 4);
    CHECK_EQ (h.log[1].time, retriggerAt);
    CHECK_EQ (h.log[3].time, retriggerAt + 9600LL);
}

TEST (scheduler_retrigger_sixty_times_a_second_never_overlaps)
{
    Harness h;
    const int blocksPerRetrigger = static_cast<int> (kRate / 60.0 / kBlock);   // ~1.5 -> 1

    int sounding = 0;
    for (int i = 0; i < 600; ++i)
    {
        if (i % (blocksPerRetrigger + 1) == 0)
            h.block ({ gated (60, 80.0f) });
        else
            h.block();
    }
    h.blocks (40);

    for (const auto& l : h.log)
    {
        sounding += l.on ? 1 : -1;
        CHECK (sounding >= 0 && sounding <= 1);
    }
    CHECK_EQ (sounding, 0);
}

TEST (scheduler_held_note_on_replaces_a_gate_and_gated_replaces_a_hold)
{
    Harness h;
    h.block ({ gated (60, 10.0f) });
    h.block ({ noteOn (60) });   // now held: the 10 ms gate must not end it
    h.blocks (40);
    CHECK (h.scheduler.anyHeld());
    CHECK_EQ (h.count (false, 60), 1);   // only the retrigger's off

    h.block ({ gated (60, 10.0f) });     // gated now: it ends by itself
    h.blocks (4);
    CHECK (! h.scheduler.anyHeld());
    CHECK_EQ (h.count (false, 60), 3);
}

TEST (scheduler_note_off_cancels_a_running_gate)
{
    Harness h;
    h.block ({ gated (60, 500.0f) });
    h.block ({ noteOff (60) });
    h.blocks (100);

    CHECK_EQ (h.count (true, 60), 1);
    CHECK_EQ (h.count (false, 60), 1);
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_same_pitch_on_other_channels_is_independent)
{
    Harness h;
    h.block ({ noteOn (60, 100, 1), noteOn (60, 100, 2), noteOn (60, 100, 16) });
    CHECK_EQ (h.log.size(), size_t (3));   // no retrigger offs between channels

    h.block ({ noteOff (60, 2) });
    CHECK_EQ (h.count (false, 60, 2), 1);
    CHECK_EQ (h.count (false, 60, 1), 0);
    CHECK_EQ (h.count (false, 60, 16), 0);
    CHECK (h.scheduler.anyHeld());
}

TEST (scheduler_release_all_ends_everything_and_empties_the_table)
{
    Harness h;
    h.block ({ noteOn (60), noteOn (64, 100, 2), gated (67, 5000.0f, 100, 5), noteOn (0, 100, 16), noteOn (127) });
    CHECK_EQ (h.log.size(), size_t (5));

    const long long releaseAt = h.blockStart + 7;
    h.out.clear();
    h.scheduler.releaseAll (h.out, 7);
    h.collect();

    REQUIRE (h.log.size() == 10);
    int offs = 0;
    for (size_t i = 5; i < h.log.size(); ++i)
    {
        CHECK (! h.log[i].on);
        CHECK_EQ (h.log[i].time, releaseAt);
        ++offs;
    }
    CHECK_EQ (offs, 5);
    CHECK_EQ (h.count (false, 64, 2), 1);
    CHECK_EQ (h.count (false, 67, 5), 1);
    CHECK_EQ (h.count (false, 0, 16), 1);
    CHECK (! h.scheduler.anyHeld());

    // The gate that was running must not fire a second note-off.
    h.blocks (500);
    CHECK_EQ (h.log.size(), size_t (10));

    // And releasing again is silent.
    h.out.clear();
    h.scheduler.releaseAll (h.out);
    CHECK_EQ (h.out.count, 0);
}

TEST (scheduler_all_notes_off_event_releases_everything)
{
    Harness h;
    h.block ({ noteOn (60), noteOn (62), gated (64, 1000.0f) });
    h.block ({ allOff() });

    CHECK_EQ (h.log.size(), size_t (6));
    CHECK (! h.scheduler.anyHeld());

    // Events after it in the same block start fresh.
    h.block ({ noteOn (60), allOff(), noteOn (61) });
    CHECK (h.scheduler.anyHeld());
    CHECK_EQ (h.count (true, 61), 1);
    CHECK_EQ (h.count (false, 61), 0);
    CHECK_EQ (h.count (false, 60), 2);
}

TEST (scheduler_clamps_out_of_range_values)
{
    Harness h;
    h.block ({ noteOn (200, 0, 0), noteOn (10, 255, 99) });

    REQUIRE (h.log.size() == 2);
    CHECK_EQ (h.log[0].note, 127);
    CHECK_EQ (h.log[0].channel, 1);
    CHECK_EQ (h.log[0].velocity, 1);
    CHECK_EQ (h.log[1].channel, 16);
    CHECK_EQ (h.log[1].velocity, 127);

    h.block ({ allOff() });
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_full_event_buffer_loses_no_note_off)
{
    Harness h;

    // Every channel and pitch on: 2048 notes, more than one block can carry.
    for (int channel = 1; channel <= 16; ++channel)
    {
        std::vector<seq::ImmediateEvent> events;
        for (int note = 0; note < 128; ++note)
            events.push_back (noteOn (note, 100, channel));
        h.block (events);
    }
    CHECK_EQ (h.log.size(), size_t (2048));

    h.log.clear();
    h.out.clear();
    h.scheduler.releaseAll (h.out, 0);
    CHECK_EQ (h.out.count, seq::kMaxEventsPerBlock);
    h.collect();
    CHECK (h.scheduler.anyHeld());   // the rest is still waiting for room

    h.block();
    CHECK_EQ (h.log.size(), size_t (2048));
    CHECK (! h.scheduler.anyHeld());

    // Every pitch on every channel was released exactly once.
    for (int channel = 1; channel <= 16; ++channel)
        for (int note = 0; note < 128; ++note)
            CHECK_EQ (h.count (false, note, channel), 1);
}

TEST (scheduler_a_note_on_that_does_not_fit_is_not_started)
{
    Harness h;
    h.out.clear();
    for (int i = 0; i < seq::kMaxEventsPerBlock; ++i)
        h.out.push ({});

    h.scheduler.handle (noteOn (60), h.out);
    CHECK (! h.scheduler.anyHeld());
}

TEST (scheduler_every_note_on_is_matched_by_a_note_off_under_random_traffic)
{
    Harness h;
    uint64_t rng = 0x9E3779B97F4A7C15ULL;
    auto next = [&rng] (int bound)
    {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        return static_cast<int> (rng % static_cast<uint64_t> (bound));
    };

    for (int b = 0; b < 4000; ++b)
    {
        std::vector<seq::ImmediateEvent> events;
        const int n = next (4);
        for (int i = 0; i < n; ++i)
        {
            const int note = 60 + next (6), channel = 1 + next (3);
            switch (next (5))
            {
                case 0:  events.push_back (noteOn (note, 100, channel)); break;
                case 1:  events.push_back (noteOff (note, channel)); break;
                case 2:  events.push_back (gated (note, static_cast<float> (next (400)), 100, channel)); break;
                case 3:  events.push_back (gated (note, static_cast<float> (next (3)), 100, channel)); break;
                default: if (next (20) == 0) events.push_back (allOff()); break;
            }
        }
        h.block (events, 64 + next (900));
    }

    h.out.clear();
    h.scheduler.releaseAll (h.out);
    h.collect();
    CHECK (! h.scheduler.anyHeld());

    // Replay the log: never two ons without an off, never an off without an on,
    // and nothing left at the end.
    int state[17][128] = {};
    for (const auto& l : h.log)
    {
        int& s = state[l.channel][l.note];
        if (l.on)
        {
            CHECK_EQ (s, 0);
            s = 1;
        }
        else
        {
            CHECK_EQ (s, 1);
            s = 0;
        }
    }
    for (auto& channel : state)
        for (int s : channel)
            CHECK_EQ (s, 0);
}
