#include "../check.h"
#include "Bridge.h"
#include "PluginProcessor.h"

#include <memory>
#include <vector>

// The processor runs headless: no editor, no host, just a fake playhead that
// the test moves forward block by block. At 48 kHz and 120 bpm one beat is
// 24000 samples, so the fixture sequence (two steps per beat) strikes a note
// every 12000 samples and its 150 ms gate is 7200 samples.
namespace
{
    constexpr double kRate  = 48000.0;
    constexpr int    kBlock = 512;

    class FakePlayHead : public juce::AudioPlayHead
    {
    public:
        juce::Optional<PositionInfo> getPosition() const override
        {
            PositionInfo info;
            info.setPpqPosition (ppq);
            info.setBpm (bpm);
            info.setIsPlaying (playing);
            info.setIsLooping (looping);
            if (looping)
                info.setLoopPoints (LoopPoints { loopStart, loopEnd });
            info.setTimeSignature (TimeSignature { 4, 4 });
            return info;
        }

        double ppq = 0.0, bpm = 120.0;
        bool   playing = false, looping = false;
        double loopStart = 0.0, loopEnd = 0.0;
    };

    // Block positions come from beats converted to samples, so a strike can land
    // a sample either side of the ideal.
    bool nearTo (long long a, long long b)
    {
        return std::llabs (a - b) <= 1;
    }

    struct Note
    {
        long long time;   // samples since the host started running blocks
        int  channel;
        int  note;
        int  velocity;
        bool on;
    };

    struct Host
    {
        FakePlayHead head;
        std::unique_ptr<PluginProcessor> processor = std::make_unique<PluginProcessor>();
        juce::AudioBuffer<float> audio { 2, kBlock };
        std::vector<Note> log;
        long long clock = 0;

        Host()
        {
            processor->setPlayHead (&head);
            processor->prepareToPlay (kRate, kBlock);
        }

        void block()
        {
            juce::MidiBuffer midi;
            // Whatever the host hands in is ignored by this plugin.
            midi.addEvent (juce::MidiMessage::noteOn (1, 1, static_cast<juce::uint8> (1)), 0);

            processor->processBlock (audio, midi);

            for (const auto meta : midi)
            {
                const auto m = meta.getMessage();
                if (m.isNoteOn() || m.isNoteOff())
                    log.push_back ({ clock + meta.samplePosition, m.getChannel(), m.getNoteNumber(),
                                     m.getVelocity(), m.isNoteOn() });
            }

            clock += kBlock;
            if (head.playing)
                head.ppq += kBlock * (head.bpm / 60.0) / kRate;
        }

        void blocks (int count)
        {
            for (int i = 0; i < count; ++i)
                block();
        }

        // Runs for at least `beats` beats at the current tempo.
        void playBeats (double beats)
        {
            const double target = head.ppq + beats;
            while (head.ppq < target)
                block();
        }

        std::vector<Note> noteOns() const
        {
            std::vector<Note> result;
            for (const auto& n : log)
                if (n.on)
                    result.push_back (n);
            return result;
        }

        int count (bool on) const
        {
            int n = 0;
            for (const auto& e : log)
                n += e.on == on ? 1 : 0;
            return n;
        }

        // Every note-on is followed by its note-off before the same note starts
        // again, and nothing is still on at the end.
        bool balanced() const
        {
            int state[17][128] = {};
            for (const auto& n : log)
            {
                int& s = state[n.channel][n.note];
                if (n.on ? s != 0 : s != 1)
                    return false;
                s = n.on ? 1 : 0;
            }
            for (auto& channel : state)
                for (int s : channel)
                    if (s != 0)
                        return false;
            return true;
        }
    };

    juce::var persistedBlob (const juce::String& name)
    {
        const auto contract = juce::JSON::parse (juce::File (SCAFFOLD_FIXTURES_DIR).getChildFile ("bridge/contract.json"));
        const auto list = contract["persisted"]["examples"];
        if (const auto* examples = list.getArray())
            for (const auto& e : *examples)
                if (e["name"].toString() == name)
                    return e["blob"];
        return {};
    }

    juce::var sequenceExample (const juce::String& name)
    {
        const auto contract = juce::JSON::parse (juce::File (SCAFFOLD_FIXTURES_DIR).getChildFile ("bridge/contract.json"));
        const auto list = contract["jsToCpp"]["setStepSequence"]["examples"];
        if (const auto* examples = list.getArray())
            for (const auto& e : *examples)
                if (e["name"].toString() == name)
                    return e["payload"];
        return {};
    }

    void loadState (PluginProcessor& processor, const juce::var& blob)
    {
        const auto text = juce::JSON::toString (blob, true);
        processor.setStateInformation (text.toRawUTF8(), static_cast<int> (text.getNumBytesAsUTF8()));
    }

    juce::MemoryBlock saved (PluginProcessor& processor)
    {
        juce::MemoryBlock block;
        processor.getStateInformation (block);
        return block;
    }

    seq::ImmediateEvent immediate (seq::ImmediateEvent::Type type, int note = 60, float ms = 0.0f)
    {
        seq::ImmediateEvent e;
        e.type       = type;
        e.note       = static_cast<uint8_t> (note);
        e.velocity   = 100;
        e.channel    = 1;
        e.durationMs = ms;
        return e;
    }

    // A one-note-per-step sequence for tests that need their own pattern.
    juce::var simpleSequence (std::initializer_list<int> notes, int tag = 5)
    {
        juce::Array<juce::var> steps;
        for (int n : notes)
        {
            auto* note = new juce::DynamicObject();
            note->setProperty ("n", n);
            note->setProperty ("d", 0);
            note->setProperty ("p", 1);
            note->setProperty ("v", 100);
            steps.add (juce::var (juce::Array<juce::var> { juce::var (note) }));
        }

        auto* payload = new juce::DynamicObject();
        payload->setProperty ("steps", steps);
        payload->setProperty ("stepsPerBeat", 2);
        payload->setProperty ("durationMs", 150);
        payload->setProperty ("legato", false);
        payload->setProperty ("tag", tag);
        return juce::var (payload);
    }
}

// ---- the reopened-project bug --------------------------------------------------------

TEST (processor_restored_v2_state_plays_without_an_editor)
{
    const auto blob = persistedBlob ("v2");
    REQUIRE (blob.isObject());

    Host host;
    loadState (*host.processor, blob);

    host.head.playing = true;
    host.playBeats (3.0);
    host.head.playing = false;
    host.blocks (2);

    const auto ons = host.noteOns();
    REQUIRE (ons.size() >= 6);
    CHECK_EQ (ons[0].note, 60);
    CHECK_EQ (ons[1].note, 64);
    CHECK_EQ (ons[2].note, 67);
    CHECK_EQ (ons[3].note, 60);   // and round again
    CHECK_EQ (ons[0].time, 0LL);
    CHECK (nearTo (ons[1].time, 12000));
    CHECK (nearTo (ons[2].time, 24000));
    CHECK_EQ (ons[0].velocity, 100);
    CHECK_EQ (ons[0].channel, 1);
    CHECK (host.balanced());
}

TEST (processor_restored_v2_state_keeps_the_web_state)
{
    Host host;
    loadState (*host.processor, persistedBlob ("v2"));

    const auto web = host.processor->getWebState();
    CHECK_EQ (web.size(), size_t (2));
    CHECK (web.count ("shell") == 1);
    CHECK (web.count ("graph") == 1);
    CHECK_EQ (web.at ("graph"), juce::String (R"({"chain":[0,2,4],"probs":[1,1,1]})"));
}

TEST (processor_restored_v1_state_has_its_web_keys_and_stays_silent)
{
    Host host;
    loadState (*host.processor, persistedBlob ("v1"));

    const auto web = host.processor->getWebState();
    CHECK_EQ (web.size(), size_t (2));
    CHECK (web.count ("shell") == 1);
    CHECK (web.count ("chord-builder") == 1);

    host.head.playing = true;
    host.playBeats (4.0);
    CHECK_EQ (host.log.size(), size_t (0));
}

TEST (processor_restoring_state_without_a_sequence_clears_the_one_playing)
{
    Host host;
    loadState (*host.processor, persistedBlob ("v2"));
    host.head.playing = true;
    host.blocks (4);
    CHECK_EQ (host.count (true), 1);

    loadState (*host.processor, persistedBlob ("v2NoSequence"));
    host.playBeats (2.0);

    CHECK_EQ (host.count (true), 1);   // only the note from before the restore
    CHECK (host.processor->getWebState().empty());

    // The saved project says so too.
    bridge::PluginState state;
    REQUIRE (bridge::parseState (saved (*host.processor).toString(), state));
    CHECK (! state.sequence.isObject());
}

TEST (processor_ignores_state_it_cannot_read)
{
    Host host;
    loadState (*host.processor, persistedBlob ("v2"));
    const auto before = saved (*host.processor);

    const char garbage[] = "this is not json";
    host.processor->setStateInformation (garbage, static_cast<int> (sizeof (garbage) - 1));
    host.processor->setStateInformation (nullptr, 0);
    host.processor->setStateInformation (garbage, 0);

    CHECK (saved (*host.processor) == before);
}

// ---- saved state ------------------------------------------------------------------------

TEST (processor_state_round_trips)
{
    Host first;
    first.processor->setWebState ("shell", R"({"root":3})");
    first.processor->setWebState ("graph", R"({"chain":[1]})");
    REQUIRE (first.processor->setStepSequence (sequenceExample ("phrasedChords")));

    const auto written = saved (*first.processor);

    Host second;
    second.processor->setStateInformation (written.getData(), static_cast<int> (written.getSize()));

    CHECK (saved (*second.processor) == written);
    CHECK (second.processor->getWebState() == first.processor->getWebState());

    // And the second instance plays what the first would have.
    first.head.playing  = true;
    second.head.playing = true;
    first.playBeats (9.0);
    second.playBeats (9.0);

    REQUIRE (first.log.size() > 0);
    CHECK_EQ (first.log.size(), second.log.size());
    for (size_t i = 0; i < first.log.size() && i < second.log.size(); ++i)
    {
        CHECK_EQ (first.log[i].time, second.log[i].time);
        CHECK_EQ (first.log[i].note, second.log[i].note);
        CHECK_EQ (first.log[i].on, second.log[i].on);
    }
}

TEST (processor_empty_state_is_v2_with_no_sequence)
{
    Host host;
    bridge::PluginState state;
    REQUIRE (bridge::parseState (saved (*host.processor).toString(), state));
    CHECK (state.web.empty());
    CHECK (! state.sequence.isObject());

    const auto parsed = juce::JSON::parse (saved (*host.processor).toString());
    CHECK_EQ (static_cast<int> (parsed["v"]), 2);
}

TEST (processor_set_step_sequence_rejects_bad_payloads_and_keeps_playing_the_old_one)
{
    Host host;
    REQUIRE (host.processor->setStepSequence (simpleSequence ({ 60, 62 })));
    const auto before = saved (*host.processor);

    CHECK (! host.processor->setStepSequence (juce::var()));
    CHECK (! host.processor->setStepSequence (juce::JSON::parse (R"({"steps":"x"})")));
    CHECK (saved (*host.processor) == before);

    host.head.playing = true;
    host.playBeats (1.0);
    const auto ons = host.noteOns();
    REQUIRE (ons.size() >= 2);
    CHECK_EQ (ons[0].note, 60);
    CHECK_EQ (ons[1].note, 62);
}

TEST (processor_save_state_from_the_page_is_part_of_the_project)
{
    Host host;
    host.processor->setWebState ("a", "1");
    host.processor->setWebState ("a", "2");   // replaces
    host.processor->setWebState ("b", "3");

    bridge::PluginState state;
    REQUIRE (bridge::parseState (saved (*host.processor).toString(), state));
    CHECK_EQ (state.web.size(), size_t (2));
    CHECK_EQ (state.web["a"], juce::String ("2"));
}

namespace
{
    struct Listener : juce::ChangeListener
    {
        void changeListenerCallback (juce::ChangeBroadcaster*) override { ++calls; }
        int calls = 0;
    };
}

TEST (processor_restoring_state_notifies_listeners)
{
    Host host;
    Listener listener;
    host.processor->addChangeListener (&listener);

    loadState (*host.processor, persistedBlob ("v2"));
    host.processor->dispatchPendingMessages();
    CHECK (listener.calls >= 1);

    // Saving from the page does not.
    const int before = listener.calls;
    host.processor->setWebState ("x", "y");
    host.processor->dispatchPendingMessages();
    CHECK_EQ (listener.calls, before);

    host.processor->removeChangeListener (&listener);
}

// ---- immediate notes ------------------------------------------------------------------------

TEST (processor_gated_immediate_note_starts_in_its_block_and_ends_on_time)
{
    Host host;
    host.blocks (3);   // the note arrives mid-run, not at the start of time

    const long long arrival = host.clock;
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::Note, 67, 200.0f));
    host.blocks (40);

    REQUIRE (host.log.size() == 2);
    CHECK (host.log[0].on);
    CHECK_EQ (host.log[0].note, 67);
    CHECK_EQ (host.log[0].time, arrival);
    CHECK (! host.log[1].on);
    CHECK_EQ (host.log[1].time, arrival + 9600);   // 200 ms
    CHECK_EQ ((host.log[1].time - arrival) % kBlock, 9600LL % kBlock);
    CHECK (host.balanced());
}

TEST (processor_held_immediate_note_is_released_by_page_loaded)
{
    Host host;
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 60));
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 64));
    host.blocks (4);
    CHECK_EQ (host.count (true), 2);
    CHECK_EQ (host.count (false), 0);

    host.processor->pageLoaded();
    host.blocks (1);
    CHECK_EQ (host.count (false), 2);
    CHECK (host.balanced());

    host.blocks (50);
    CHECK_EQ (host.log.size(), size_t (4));   // nothing else, nothing left
}

TEST (processor_held_immediate_note_is_released_when_the_editor_goes_away)
{
    Host host;
    host.processor->editorAttached();
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 60));
    host.blocks (2);

    host.processor->editorDetached();
    host.blocks (1);
    CHECK (host.balanced());
    CHECK_EQ (host.count (false), 1);
}

TEST (processor_page_loaded_and_editor_detached_do_not_stop_the_sequence)
{
    Host host;
    loadState (*host.processor, persistedBlob ("v2"));
    host.processor->editorAttached();

    host.head.playing = true;
    host.blocks (30);   // inside the second step
    host.processor->pageLoaded();
    host.blocks (30);
    host.processor->editorDetached();
    host.playBeats (2.5);

    const auto ons = host.noteOns();
    REQUIRE (ons.size() >= 6);

    // Strike times are still on the step grid and the pattern never skipped.
    const int pattern[] = { 60, 64, 67 };
    for (size_t i = 0; i < ons.size(); ++i)
    {
        CHECK (nearTo (ons[i].time, static_cast<long long> (i) * 12000));
        CHECK_EQ (ons[i].note, pattern[i % 3]);
    }

    // Each note ended by itself, 150 ms after it began.
    for (size_t i = 0; i + 1 < ons.size(); ++i)
        CHECK (nearTo (host.log[i * 2 + 1].time, ons[i].time + 7200));
}

TEST (processor_every_note_on_has_a_note_off_after_the_transport_stops)
{
    Host host;
    loadState (*host.processor, persistedBlob ("v2"));

    host.head.playing = true;
    host.blocks (2);           // a note is sounding, 1024 samples into its gate
    CHECK_EQ (host.count (true), 1);
    CHECK_EQ (host.count (false), 0);

    host.head.playing = false;
    host.block();
    CHECK_EQ (host.count (false), 1);
    CHECK_EQ (host.log.back().time, host.clock - kBlock);   // at the start of the first stopped block

    host.blocks (200);
    CHECK_EQ (host.log.size(), size_t (2));
    CHECK (host.balanced());
}

TEST (processor_loop_wrap_keeps_notes_balanced)
{
    Host host;
    REQUIRE (host.processor->setStepSequence (simpleSequence ({ 60, 62, 64, 65 })));

    host.head.playing   = true;
    host.head.looping   = true;
    host.head.loopStart = 0.0;
    host.head.loopEnd   = 2.0;

    for (int i = 0; i < 400; ++i)
    {
        host.block();
        if (host.head.ppq >= host.head.loopEnd)
            host.head.ppq -= host.head.loopEnd - host.head.loopStart;
    }
    host.head.playing = false;
    host.block();

    CHECK (host.count (true) > 8);
    CHECK (host.balanced());
}

TEST (processor_bypass_releases_everything_once_and_stays_silent)
{
    Host host;
    loadState (*host.processor, persistedBlob ("v2"));
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 72));

    host.head.playing = true;
    host.blocks (2);
    CHECK_EQ (host.count (true), 2);   // the sequence's first note and the held one

    juce::MidiBuffer midi;
    midi.addEvent (juce::MidiMessage::noteOn (1, 1, static_cast<juce::uint8> (1)), 0);
    host.processor->processBlockBypassed (host.audio, midi);

    int offs = 0;
    for (const auto meta : midi)
    {
        CHECK (meta.getMessage().isNoteOff());
        ++offs;
    }
    CHECK_EQ (offs, 2);

    // Later bypassed blocks send nothing, even though queued notes arrive.
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 80));
    for (int i = 0; i < 50; ++i)
    {
        midi.addEvent (juce::MidiMessage::noteOn (1, 1, static_cast<juce::uint8> (1)), 0);
        host.processor->processBlockBypassed (host.audio, midi);
        CHECK (midi.isEmpty());
    }
}

TEST (processor_prepare_to_play_releases_what_was_sounding)
{
    Host host;
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 60));
    host.blocks (2);
    CHECK_EQ (host.count (true), 1);

    host.processor->prepareToPlay (44100.0, 256);
    host.blocks (1);
    CHECK_EQ (host.count (false), 1);
    CHECK (host.balanced());
}

TEST (processor_a_full_immediate_queue_cannot_leave_a_note_stuck)
{
    Host host;

    // Fill the queue (nothing drains it), then lose a note-off.
    for (int i = 0; i < PluginProcessor::kImmediateQueueCapacity; ++i)
        host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 40 + i % 40));
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 100));    // dropped: only a missed note
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOff, 41));    // dropped: sets the panic

    host.blocks (3);
    CHECK (host.count (true) > 0);
    CHECK (host.balanced());

    // Everything still works afterwards.
    host.processor->pushImmediate (immediate (seq::ImmediateEvent::NoteOn, 90));
    host.blocks (1);
    CHECK_EQ (host.noteOns().back().note, 90);
}

// ---- step events for the editor -----------------------------------------------------------------

TEST (processor_reports_steps_only_while_an_editor_is_attached)
{
    Host host;
    REQUIRE (host.processor->setStepSequence (simpleSequence ({ 60, 62, 64 }, 77)));
    host.head.playing = true;

    seq::StepEvent events[PluginProcessor::kStepQueueCapacity];

    // Nobody is looking: nothing is queued.
    host.playBeats (1.0);
    CHECK_EQ (host.processor->popStepEvents (events, 128), 0);

    // Attaching starts from now.
    host.processor->editorAttached();
    const double start = host.head.ppq;
    host.playBeats (2.0);

    const int n = host.processor->popStepEvents (events, 128);
    REQUIRE (n >= 4);
    CHECK_EQ (events[0].tag, 77);
    CHECK (events[0].stepsPerBeat > 1.999 && events[0].stepsPerBeat < 2.001);
    CHECK_EQ (events[0].numPlayed, 1);
    CHECK_EQ (events[0].index, static_cast<int> (std::ceil (start * 2.0)));
    for (int i = 1; i < n; ++i)
        CHECK_EQ (events[i].index, events[i - 1].index + 1);

    CHECK_EQ (static_cast<int> (events[0].played[0]), (events[0].index % 3 == 0 ? 60 : events[0].index % 3 == 1 ? 62 : 64));

    // And nothing once it has gone.
    host.processor->editorDetached();
    host.playBeats (1.0);
    CHECK_EQ (host.processor->popStepEvents (events, 128), 0);
}

TEST (processor_reattaching_discards_stale_step_events)
{
    Host host;
    REQUIRE (host.processor->setStepSequence (simpleSequence ({ 60 })));
    host.head.playing = true;

    host.processor->editorAttached();
    host.playBeats (2.0);          // queued, never read
    host.processor->editorDetached();

    host.processor->editorAttached();
    seq::StepEvent events[PluginProcessor::kStepQueueCapacity];
    CHECK_EQ (host.processor->popStepEvents (events, 128), 0);
}

TEST (processor_step_queue_drops_when_full_and_pop_respects_the_limit)
{
    Host host;
    REQUIRE (host.processor->setStepSequence (simpleSequence ({ 60 })));
    host.head.playing = true;
    host.head.bpm     = 240.0;

    host.processor->editorAttached();
    host.playBeats (200.0);   // 400 steps into a 128-event queue nobody reads

    seq::StepEvent events[PluginProcessor::kStepQueueCapacity];
    CHECK_EQ (host.processor->popStepEvents (events, 10), 10);

    // The fifo keeps one slot free, so a full queue holds one less than its size.
    const int rest = host.processor->popStepEvents (events, 128);
    CHECK (rest >= PluginProcessor::kStepQueueCapacity - 11 && rest <= PluginProcessor::kStepQueueCapacity - 10);
    CHECK_EQ (host.processor->popStepEvents (events, 128), 0);
}

TEST (processor_reports_an_empty_sequence_clock)
{
    Host host;
    host.head.playing = true;
    host.processor->editorAttached();
    host.playBeats (2.0);

    seq::StepEvent events[PluginProcessor::kStepQueueCapacity];
    const int n = host.processor->popStepEvents (events, 128);
    CHECK (n >= 3);
    for (int i = 0; i < n; ++i)
        CHECK_EQ (events[i].numPlayed, 0);
    CHECK_EQ (host.log.size(), size_t (0));
}

TEST (processor_publishes_the_transport)
{
    Host host;
    host.head.playing = true;
    host.head.bpm     = 90.0;
    host.head.ppq     = 12.5;
    host.block();

    const auto& t = host.processor->transport;
    CHECK (t.isPlaying.load());
    CHECK (t.bpm.load() > 89.999 && t.bpm.load() < 90.001);
    CHECK (t.beatPosition.load() > 12.499 && t.beatPosition.load() < 12.501);
    CHECK_EQ (t.timeSigNumerator.load(), 4);
    CHECK_EQ (t.timeSigDenominator.load(), 4);

    host.head.playing = false;
    host.block();
    CHECK (! t.isPlaying.load());
}

TEST (processor_handles_a_host_without_a_playhead)
{
    auto processor = std::make_unique<PluginProcessor>();
    processor->prepareToPlay (kRate, kBlock);
    REQUIRE (processor->setStepSequence (simpleSequence ({ 60 })));

    juce::AudioBuffer<float> audio (2, kBlock);
    juce::MidiBuffer midi;
    for (int i = 0; i < 20; ++i)
    {
        processor->processBlock (audio, midi);
        CHECK (midi.isEmpty());
    }
}
