#include "sequencer_support.h"

#include <cstdio>
#include <cstdlib>

// The step events: the UI's only clock, and the identical-resend guarantee that
// goes with it.
using namespace seqtest;

namespace
{

std::vector<int> playedOf (const seq::StepEvent& e)
{
    return { e.played.begin(), e.played.begin() + e.numPlayed };
}

}

TEST (sequencer_reports_one_step_event_per_boundary)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto s    = build (2.0, 100.0, { { 60 }, { 62 }, { 64 }, { 65 } }, false, 7);

        host.run (size, true, s.get());
        host.play (4 * 32768 - size, size);   // four beats: eight half-beat steps

        const int cycle[] = { 60, 62, 64, 65 };

        REQUIRE (host.stepLog.size() == 8);
        for (size_t i = 0; i < host.stepLog.size(); ++i)
        {
            const auto& e = host.stepLog[i].event;

            CHECK_EQ (e.index, static_cast<int> (i));
            CHECK_EQ (e.stepsPerBeat, 2.0);
            CHECK_EQ (e.tag, 7);
            CHECK (playedOf (e) == (std::vector<int> { cycle[i % 4] }));
        }

        // The block that holds a boundary is the block that reports it.
        for (const auto& r : host.stepLog)
            CHECK_EQ (r.blockStart / size, (r.event.index * 16384LL) / size);
    });
}

TEST (sequencer_reports_the_steps_of_an_empty_sequence)
{
    atBlockSizes ([] (int size)
    {
        auto host  = Host::grid();
        auto empty = build (4.0, 100.0, {}, false, 9);

        host.run (size, true, empty.get());
        host.play (2 * 32768 - size, size);

        // Eight quarter-beat steps, no notes, no MIDI.
        REQUIRE (host.stepLog.size() == 8);
        for (size_t i = 0; i < 8; ++i)
        {
            CHECK_EQ (host.stepLog[i].event.index, static_cast<int> (i));
            CHECK_EQ (host.stepLog[i].event.stepsPerBeat, 4.0);
            CHECK_EQ (host.stepLog[i].event.tag, 9);
            CHECK_EQ (host.stepLog[i].event.numPlayed, 0);
        }
        CHECK (host.log.empty());

        // A sequence posted into the running count picks up at the next boundary,
        // and the numbering carries on.
        auto s = build (4.0, 100.0, { { 60 } }, false, 9);
        host.run (size, true, s.get());
        host.play (8192, size);

        const auto& last = host.stepLog.back().event;
        CHECK (last.index >= 9);
        CHECK (playedOf (last) == (std::vector<int> { 60 }));
        CHECK (! host.log.empty());

        host.stop();
        CHECK_BALANCED (host.log);
    });
}

TEST (sequencer_reports_steps_before_any_sequence_arrives)
{
    auto host = Host::grid();
    host.run (32768 * 2);   // the default rate: two steps a beat

    REQUIRE (host.stepLog.size() == 4);
    CHECK_EQ (host.stepLog[0].event.index, 0);
    CHECK_EQ (host.stepLog[3].event.index, 3);
    CHECK_EQ (host.stepLog[0].event.stepsPerBeat, 2.0);
    CHECK_EQ (host.stepLog[0].event.tag, 0);
    CHECK (host.log.empty());
}

TEST (sequencer_reports_no_steps_while_stopped)
{
    auto host = Host::grid();
    auto s    = build (4.0, 100.0, { { 60 } });

    host.run (32768, false, s.get());
    host.run (32768, false);
    CHECK_EQ (host.steps.count, 0);
    CHECK (host.stepLog.empty());
}

TEST (sequencer_reports_slow_rates_by_the_bar)
{
    auto host = Host::grid();
    auto s    = build (0.25, 100.0, { { 60 } });   // one step per 4/4 bar

    host.beatPos = 3.5;
    host.run (32768 * 10, true, s.get());   // beats 3.5 to 13.5

    // Boundaries at beats 4, 8 and 12: steps 1, 2 and 3.
    REQUIRE (host.stepLog.size() == 3);
    CHECK_EQ (host.stepLog[0].event.index, 1);
    CHECK_EQ (host.stepLog[2].event.index, 3);
    CHECK_EQ (host.stepLog[0].event.stepsPerBeat, 0.25);
}

TEST (sequencer_reports_what_played_including_phrased_and_excluding_the_dice)
{
    auto host = Host::grid();
    auto s    = build (1.0, 100.0, { { 60, N (62, 0.5), N (64, 0.0, 0.0f), N (67, 0.5, 0.0f), 69 } });

    host.run (32768 * 3 / 2, true, s.get());

    // 62 is phrased, so it sounds later, but it is part of the step. The notes
    // whose dice failed are not.
    REQUIRE (host.stepLog.size() == 2);
    CHECK (playedOf (host.stepLog[0].event) == (std::vector<int> { 60, 62, 69 }));
    CHECK (playedOf (host.stepLog[1].event) == (std::vector<int> { 60, 62, 69 }));
}

TEST (sequencer_reports_the_full_chord_in_legato_mode)
{
    auto host = Host::grid();
    auto s    = build (1.0, 100.0, { { 60, 64 }, { 60, 67 } }, true);

    host.run (32768 * 2 + 100, true, s.get());

    // The second step only starts 67 (60 keeps ringing), yet it lists both.
    REQUIRE (host.stepLog.size() == 3);
    CHECK (playedOf (host.stepLog[0].event) == (std::vector<int> { 60, 64 }));
    CHECK (playedOf (host.stepLog[1].event) == (std::vector<int> { 60, 67 }));
    CHECK_EQ (host.times (60, true).size(), 1u);
}

TEST (sequencer_does_not_report_notes_struck_by_an_edit)
{
    auto host   = Host::grid();
    auto before = build (1.0, 2000.0, { { 60 } });
    auto after  = build (1.0, 2000.0, { { 60, 64 } });

    host.run (4096, true, before.get());
    const auto events = host.run (512, true, after.get());

    REQUIRE (events.size() == 1);   // the edit did strike 64
    REQUIRE (host.stepLog.size() == 1);
    CHECK (playedOf (host.stepLog[0].event) == (std::vector<int> { 60 }));
}

TEST (sequencer_reports_the_tag_in_effect_at_each_boundary)
{
    atBlockSizes ([] (int size)
    {
        auto host = Host::grid();
        auto one  = build (1.0, 100.0, { { 60 }, { 62 } }, false, 1);
        auto two  = build (1.0, 100.0, { { 64 }, { 65 } }, false, 2);

        host.run (size, true, one.get());
        host.play (2 * 32768 - 4096, size);
        host.run (size, true, two.get());
        host.play (2 * 32768, size);

        REQUIRE (host.stepLog.size() >= 4);
        CHECK_EQ (host.stepLog[0].event.tag, 1);
        CHECK_EQ (host.stepLog[1].event.tag, 1);
        CHECK_EQ (host.stepLog[2].event.tag, 2);
        CHECK_EQ (host.stepLog[3].event.tag, 2);
    });
}

// ---- an identical resend is silent -------------------------------------------

namespace
{

struct Outcome
{
    std::vector<Timed>      midi;
    std::vector<StepRecord> steps;
    long long               resendAt = 0;   // start of the block that carried the resend
};

enum class Resend
{
    None,
    Identical,     // the same content again, with another tag
    ThroughText,   // the same content after a trip through JSON text, as a saved sequence comes back
    Nudged         // a real edit: one delay a millionth of a step later
};

// The number as text with about 15 significant digits and back.
double throughText (double v)
{
    char text[64];
    std::snprintf (text, sizeof text, "%.15g", v);
    return std::strtod (text, nullptr);
}

void sendThroughText (seq::Sequence& s)
{
    s.stepsPerBeat = throughText (s.stepsPerBeat);
    s.gateMs       = throughText (s.gateMs);

    for (int i = 0; i < s.numSteps; ++i)
        for (int j = 0; j < s.steps[static_cast<size_t> (i)].numNotes; ++j)
        {
            auto& delay = s.steps[static_cast<size_t> (i)].notes[static_cast<size_t> (j)].delay;
            delay = throughText (delay);
        }
}

bool sameBits (const seq::Sequence& a, const seq::Sequence& b)
{
    if (a.stepsPerBeat != b.stepsPerBeat || a.gateMs != b.gateMs)
        return false;

    for (int i = 0; i < a.numSteps; ++i)
        for (int j = 0; j < a.steps[static_cast<size_t> (i)].numNotes; ++j)
            if (a.steps[static_cast<size_t> (i)].notes[static_cast<size_t> (j)].delay
                != b.steps[static_cast<size_t> (i)].notes[static_cast<size_t> (j)].delay)
                return false;
    return true;
}

// Plays a sequence for a while on the exact grid. With a resend, the content
// comes in again with a different tag in the middle of a step.
Outcome playWithResend (const seq::Sequence& sequence, Resend resend, int size)
{
    auto host = Host::grid();
    host.sequencer->setSeed (99);

    host.run (size, true, &sequence);
    host.play (80000 / size * size - size, size);   // about 2.4 beats: inside a half-beat step

    const long long resendAt = host.elapsed;

    if (resend != Resend::None)
    {
        auto again = std::make_unique<seq::Sequence>();
        again->copyFrom (sequence);
        again->tag = sequence.tag + 1;

        if (resend == Resend::ThroughText)
            sendThroughText (*again);
        if (resend == Resend::Nudged && again->numSteps > 0 && again->steps[0].numNotes > 0)
            again->steps[0].notes[0].delay += 1.0e-6;

        host.run (size, true, again.get());
    }
    else
    {
        host.run (size);
    }

    host.play (6 * 32768, size);
    host.stop();
    CHECK_BALANCED (host.log);
    return { host.log, host.stepLog, resendAt };
}

void checkResendChangesOnlyTheTag (const seq::Sequence& sequence, Resend kind = Resend::Identical)
{
    atBlockSizes ([&sequence, kind] (int size)
    {
        const auto plain  = playWithResend (sequence, Resend::None, size);
        const auto resent = playWithResend (sequence, kind, size);

        CHECK_EQ (plain.resendAt % 16384 != 0, true);   // really in the middle of a step
        REQUIRE (plain.midi.size() == resent.midi.size());
        for (size_t i = 0; i < plain.midi.size(); ++i)
        {
            CHECK_EQ (plain.midi[i].sample, resent.midi[i].sample);
            CHECK (plain.midi[i].event.note == resent.midi[i].event.note);
            CHECK (plain.midi[i].event.on == resent.midi[i].event.on);
        }
        CHECK (sequence.numSteps == 0 || ! plain.midi.empty());

        REQUIRE (plain.steps.size() == resent.steps.size());
        for (size_t i = 0; i < plain.steps.size(); ++i)
        {
            const auto& a = plain.steps[i];
            const auto& b = resent.steps[i];

            CHECK_EQ (a.blockStart, b.blockStart);
            CHECK_EQ (a.event.index, b.event.index);
            CHECK (playedOf (a.event) == playedOf (b.event));
            CHECK_EQ (a.event.tag, sequence.tag);
            CHECK_EQ (b.event.tag, b.blockStart < resent.resendAt ? sequence.tag : sequence.tag + 1);
        }
    });
}

}

TEST (sequencer_identical_resend_is_silent_and_changes_only_the_tag)
{
    checkResendChangesOnlyTheTag (*build (2.0, 150.0, { { 60, 64 }, { 62 }, { 65, 69 } }, false, 5));
}

TEST (sequencer_identical_resend_does_not_disturb_phrased_notes_or_dice)
{
    // Notes pending their phrase, ringing gates and probabilities that would
    // change the dice stream if a resend re-rolled them.
    checkResendChangesOnlyTheTag (*build (2.0, 400.0,
        { { N (60, 0.0, 0.5f), N (64, 0.7, 0.5f), N (67, 0.3) }, { N (62, 0.9, 0.75f) } }, false, 5));
}

TEST (sequencer_identical_resend_is_silent_in_legato_mode)
{
    checkResendChangesOnlyTheTag (*build (2.0, 150.0, { { 60, 64 }, { 60, 67 } }, true, 5));
}

TEST (sequencer_identical_resend_of_an_empty_sequence_is_silent)
{
    checkResendChangesOnlyTheTag (*build (2.0, 150.0, {}, false, 5));
}

namespace
{

// A phrased note (62) that rings 8/9 of a step into the next step, where a
// changed sequence would silence it, and numbers that do not survive text:
// thirds and ninths, and a rate an ulp above 2.
std::unique_ptr<seq::Sequence> sequenceWithAwkwardNumbers()
{
    return build (2.0000000000000004, 1000.0 / 3.0,
                  { { N (60, 1.0 / 9.0), N (64, 1.0 / 3.0) }, { N (62, 8.0 / 9.0) } }, false, 5);
}

}

TEST (sequencer_identical_resend_after_a_trip_through_text_is_silent)
{
    auto s = sequenceWithAwkwardNumbers();

    // The test means something only if the numbers do come back different.
    auto text = std::make_unique<seq::Sequence>();
    text->copyFrom (*s);
    sendThroughText (*text);
    CHECK (! sameBits (*s, *text));

    checkResendChangesOnlyTheTag (*s, Resend::ThroughText);
}

TEST (sequencer_a_delay_edited_by_a_millionth_of_a_step_is_an_edit)
{
    // The same scenario with a real (if tiny) edit: the reconciliation runs and
    // silences the ringing note, so the output differs from the plain run.
    auto s = sequenceWithAwkwardNumbers();

    atBlockSizes ([&s] (int size)
    {
        const auto plain  = playWithResend (*s, Resend::None, size);
        const auto edited = playWithResend (*s, Resend::Nudged, size);

        bool differs = plain.midi.size() != edited.midi.size();
        for (size_t i = 0; ! differs && i < plain.midi.size(); ++i)
            differs = plain.midi[i].sample != edited.midi[i].sample
                   || plain.midi[i].event.note != edited.midi[i].event.note
                   || plain.midi[i].event.on != edited.midi[i].event.on;
        CHECK (differs);
    });
}
