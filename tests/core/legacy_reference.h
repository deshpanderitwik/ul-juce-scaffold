#pragma once

#include "StepSequencer.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <vector>

// =============================================================================
// LegacySequencer — the reference the real sequencer is tested against.
//
// This is the step-sequencer section of PluginProcessor::processBlock as it
// stood before the sequencer moved into seq::StepSequencer, transliterated
// statement for statement. It is meant to be diffed against that code, so it
// is deliberately NOT tidied: same data layout (vector of vector of notes),
// same order of operations, same double arithmetic. The only substitutions:
//
//   midiMessages.addEvent (MidiMessage::noteOn/noteOff (...), offset)
//                               -> the MidiBuffer / MidiMessage shims below,
//                                  which append a seq::MidiEvent to a vector
//   juce::jlimit (lo, hi, v)    -> std::clamp (v, lo, hi)
//   juce::uint8                 -> uint8_t
//   SpinLock + atomic dirty flag-> post() sets a plain dirty flag, consumed in
//                                  the same place the processor consumed it
//   juce::Random::nextDouble()  -> the injected dice function
//   std::vector::reserve calls  -> dropped (they do not change behaviour)
// =============================================================================
namespace legacy
{

// ---- shims for the only two JUCE types the section touches -------------------

struct MidiMessage
{
    seq::MidiEvent event;

    static MidiMessage noteOn (int channel, int note, uint8_t velocity)
    {
        MidiMessage m;
        m.event.note     = static_cast<uint8_t> (note);
        m.event.velocity = velocity;
        m.event.channel  = static_cast<uint8_t> (channel);
        m.event.on       = true;
        return m;
    }

    static MidiMessage noteOff (int channel, int note, uint8_t velocity)
    {
        MidiMessage m;
        m.event.note     = static_cast<uint8_t> (note);
        m.event.velocity = velocity;
        m.event.channel  = static_cast<uint8_t> (channel);
        m.event.on       = false;
        return m;
    }
};

struct MidiBuffer
{
    std::vector<seq::MidiEvent> events;

    void addEvent (const MidiMessage& message, int sampleOffset)
    {
        auto e = message.event;
        e.sampleOffset = sampleOffset;
        events.push_back (e);
    }
};

// ---- the state structs from PluginProcessor.h --------------------------------

struct StepNote
{
    int    note        = 60;
    double delay       = 0.0;   // fraction of one step, [0, 1)
    double probability = 1.0;   // chance this note triggers, [0, 1]
};

struct StepSequenceState
{
    std::vector<std::vector<StepNote>> steps;
    double subdivisionMultiplier = 2.0;
    double noteDurationMs        = 150.0;
    bool legato = false;
};

struct PendingNoteOff
{
    int    note         = 60;
    int    channel      = 1;
    double beatPosition = 0.0;
};

struct PendingNoteOn
{
    int    note         = 60;
    int    channel      = 1;
    double beatPosition = 0.0;   // when to trigger
    double gateBeats    = 0.5;   // note length once triggered
};

// ---- the processor's members and the section of processBlock -----------------

struct LegacySequencer
{
    using Dice = std::function<double()>;

    LegacySequencer (double sampleRate, Dice diceFunction)
        : currentSampleRate (sampleRate), dice (std::move (diceFunction)) {}

    // PluginProcessor::setStepSequence: message thread publishes, the audio
    // thread picks it up on a later block.
    void post (const StepSequenceState& state)
    {
        sequenceState = state;
        sequenceDirty = true;
    }

    // One processBlock call. beatPos / bpm / playing come from the playhead,
    // midiMessages is the (already cleared) output buffer.
    void process (double beatPos, double bpm, bool playing, int numSamples,
                  MidiBuffer& midiMessages)
    {
    if (playing)
    {
        const double beatsPerSample = (bpm / 60.0) / currentSampleRate;
        const double bufferEndBeat  = beatPos + beatsPerSample * numSamples;

        // Detect timeline jump (loop, scrub, rewind)
        if (beatPos < lastBeatPos - beatsPerSample)
        {
            lastStepIndex = -1;
            for (const auto& noff : pendingNoteOffs)
                midiMessages.addEvent (
                    MidiMessage::noteOff (noff.channel, noff.note, static_cast<uint8_t> (0)), 0);
            pendingNoteOffs.clear();

            for (int held : heldNotes)
                midiMessages.addEvent (
                    MidiMessage::noteOff (1, held, static_cast<uint8_t> (0)), 0);
            heldNotes.clear();

            pendingNoteOns.clear();   // not sounding yet — just drop them
        }
        lastBeatPos = bufferEndBeat;

        if (sequenceDirty)
        {
            {   // the try-lock always succeeds here
                // Keep the pre-edit chord for the step we're inside — the
                // reconciliation below diffs the edit against it.
                std::vector<StepNote> oldChord;
                const int    oldN    = static_cast<int> (audioSequence.steps.size());
                const double oldMult = audioSequence.subdivisionMultiplier;
                const bool   hadStep = lastStepIndex >= 0 && oldN > 0 && ! audioSequence.legato;
                if (hadStep)
                    oldChord = audioSequence.steps[
                        static_cast<size_t> (((lastStepIndex % oldN) + oldN) % oldN)];

                audioSequence = sequenceState;
                sequenceDirty = false;

                const auto& newSeq = audioSequence;
                const int   newN   = static_cast<int> (newSeq.steps.size());

                const bool sameMult =
                    std::abs (newSeq.subdivisionMultiplier - oldMult) < 1.0e-9;

                if (hadStep && ! newSeq.legato && newN == oldN && sameMult)
                {
                    const auto& newChord = newSeq.steps[
                        static_cast<size_t> (((lastStepIndex % newN) + newN) % newN)];

                    auto inNewChord = [&newChord] (int note)
                    {
                        return std::any_of (newChord.begin(), newChord.end(),
                            [note] (const StepNote& sn) { return sn.note == note; });
                    };
                    auto wasInOldChord = [&oldChord] (int note)
                    {
                        return std::any_of (oldChord.begin(), oldChord.end(),
                            [note] (const StepNote& sn) { return sn.note == note; });
                    };

                    // Removed notes: silence ringing ones now, drop phrased
                    // ones that haven't fired yet.
                    for (auto it = pendingNoteOffs.begin(); it != pendingNoteOffs.end(); )
                    {
                        if (! inNewChord (it->note))
                        {
                            midiMessages.addEvent (
                                MidiMessage::noteOff (it->channel, it->note, static_cast<uint8_t> (0)), 0);
                            it = pendingNoteOffs.erase (it);
                        }
                        else
                        {
                            ++it;
                        }
                    }
                    for (auto it = pendingNoteOns.begin(); it != pendingNoteOns.end(); )
                    {
                        if (! inNewChord (it->note))
                            it = pendingNoteOns.erase (it);
                        else
                            ++it;
                    }

                    // Added notes: strike them into the remainder of the step.
                    const double stepLen      = 1.0 / newSeq.subdivisionMultiplier;
                    const double boundaryBeat = static_cast<double> (lastStepIndex) * stepLen;
                    const double gateBeats    = std::clamp (
                        newSeq.noteDurationMs * 0.001 * (bpm / 60.0), 0.01, stepLen);

                    for (const auto& sn : newChord)
                    {
                        if (wasInOldChord (sn.note))
                            continue;   // untouched by this edit
                        if (sn.probability < 1.0 && dice() >= sn.probability)
                            continue;

                        const double triggerBeat = boundaryBeat + sn.delay * stepLen;
                        const double offBeat     = triggerBeat + gateBeats;

                        if (offBeat <= beatPos)
                            continue;   // its window in this step already passed

                        if (triggerBeat > beatPos)
                        {
                            // Phrased moment still ahead — let it fire on time
                            pendingNoteOns.push_back ({ sn.note, 1, triggerBeat, gateBeats });
                        }
                        else
                        {
                            midiMessages.addEvent (
                                MidiMessage::noteOn (1, sn.note, static_cast<uint8_t> (100)), 0);
                            pendingNoteOffs.push_back ({ sn.note, 1, offBeat });
                        }
                    }
                }
            }
        }
        const StepSequenceState& seq = audioSequence;

        // If legato notes are ringing but the sequence can no longer sustain
        // them (cleared, or replaced by a non-legato one), release them now.
        if ((seq.steps.empty() || ! seq.legato) && ! heldNotes.empty())
        {
            for (int held : heldNotes)
                midiMessages.addEvent (
                    MidiMessage::noteOff (1, held, static_cast<uint8_t> (0)), 0);
            heldNotes.clear();
        }

        // Phrased notes scheduled from a sequence that no longer exists
        if (seq.steps.empty())
            pendingNoteOns.clear();

        // Process pending note-offs BEFORE new note-ons so that when the same
        // MIDI note has a note-off and note-on at the same sample, the off clears first.
        for (auto it = pendingNoteOffs.begin(); it != pendingNoteOffs.end(); )
        {
            if (it->beatPosition <= bufferEndBeat)
            {
                int sampleOffset = static_cast<int> (
                    (it->beatPosition - beatPos) / beatsPerSample);
                sampleOffset = std::clamp (sampleOffset, 0, numSamples - 1);

                midiMessages.addEvent (
                    MidiMessage::noteOff (it->channel, it->note, static_cast<uint8_t> (0)),
                    sampleOffset);

                it = pendingNoteOffs.erase (it);
            }
            else
            {
                ++it;
            }
        }

        if (! seq.steps.empty())
        {
            const double mult       = seq.subdivisionMultiplier;
            const double stepSize   = 1.0 / mult;

            // Gate length from the UI-supplied duration, capped at one full
            // step so a note always ends before the same pitch can retrigger.
            const double durationBeats = std::clamp (
                seq.noteDurationMs * 0.001 * (bpm / 60.0), 0.01, stepSize);

            int firstStep = static_cast<int> (std::ceil (beatPos * mult));
            int lastStep  = static_cast<int> (std::floor (bufferEndBeat * mult));

            if (firstStep <= lastStepIndex)
                firstStep = lastStepIndex + 1;

            for (int s = firstStep; s <= lastStep; ++s)
            {
                double boundaryBeat = static_cast<double> (s) * stepSize;

                if (boundaryBeat >= bufferEndBeat)
                    break;

                int sampleOffset = static_cast<int> (
                    (boundaryBeat - beatPos) / beatsPerSample);
                sampleOffset = std::clamp (sampleOffset, 0, numSamples - 1);

                const int numSteps = static_cast<int> (seq.steps.size());
                int stepIndex = ((s % numSteps) + numSteps) % numSteps;
                const auto& chord = seq.steps[static_cast<size_t> (stepIndex)];

                if (seq.legato)
                {
                    // Diff transition: release held notes leaving the chord...
                    for (auto it = heldNotes.begin(); it != heldNotes.end(); )
                    {
                        const int held = *it;
                        const bool stays = std::any_of (chord.begin(), chord.end(),
                            [held] (const StepNote& sn) { return sn.note == held; });

                        if (! stays)
                        {
                            midiMessages.addEvent (
                                MidiMessage::noteOff (1, held, static_cast<uint8_t> (0)),
                                sampleOffset);
                            it = heldNotes.erase (it);
                        }
                        else
                        {
                            ++it;
                        }
                    }

                    // ...start notes entering it; notes in both keep ringing.
                    for (const auto& sn : chord)
                    {
                        if (std::find (heldNotes.begin(), heldNotes.end(), sn.note) == heldNotes.end())
                        {
                            midiMessages.addEvent (
                                MidiMessage::noteOn (1, sn.note, static_cast<uint8_t> (100)),
                                sampleOffset);
                            heldNotes.push_back (sn.note);
                        }
                    }
                }
                else
                {
                    for (const auto& sn : chord)
                    {
                        // Roll the dice once per hit — probability below 1.0
                        // makes the note trigger only sometimes.
                        if (sn.probability < 1.0 && dice() >= sn.probability)
                            continue;

                        if (sn.delay <= 0.0)
                        {
                            midiMessages.addEvent (
                                MidiMessage::noteOn (1, sn.note, static_cast<uint8_t> (100)),
                                sampleOffset);

                            pendingNoteOffs.push_back ({ sn.note, 1, boundaryBeat + durationBeats });
                        }
                        else
                        {
                            // Phrased — trigger later within the step.
                            pendingNoteOns.push_back (
                                { sn.note, 1, boundaryBeat + sn.delay * stepSize, durationBeats });
                        }
                    }
                }
                lastStepIndex = s;
            }
        }

        // Fire phrased note-ons whose beat falls inside this buffer. Runs
        // after the boundary loop so a small delay can trigger in the same
        // block it was scheduled in; runs after the note-off pass so an off
        // and on for the same pitch at one sample stay off-then-on.
        for (auto it = pendingNoteOns.begin(); it != pendingNoteOns.end(); )
        {
            if (it->beatPosition < bufferEndBeat)
            {
                int sampleOffset = static_cast<int> (
                    (it->beatPosition - beatPos) / beatsPerSample);
                sampleOffset = std::clamp (sampleOffset, 0, numSamples - 1);

                midiMessages.addEvent (
                    MidiMessage::noteOn (it->channel, it->note, static_cast<uint8_t> (100)),
                    sampleOffset);

                pendingNoteOffs.push_back ({ it->note, it->channel, it->beatPosition + it->gateBeats });
                it = pendingNoteOns.erase (it);
            }
            else
            {
                ++it;
            }
        }
    }
    else
    {
        // Transport stopped — reset step tracking and flush anything sounding
        if (wasPlaying)
        {
            for (const auto& noff : pendingNoteOffs)
            {
                midiMessages.addEvent (
                    MidiMessage::noteOff (noff.channel, noff.note, static_cast<uint8_t> (0)),
                    0);
            }
            pendingNoteOffs.clear();

            for (int held : heldNotes)
            {
                midiMessages.addEvent (
                    MidiMessage::noteOff (1, held, static_cast<uint8_t> (0)),
                    0);
            }
            heldNotes.clear();

            pendingNoteOns.clear();
        }
        lastStepIndex = -1;
    }

    wasPlaying = playing;
    }

    StepSequenceState sequenceState;
    bool              sequenceDirty = false;
    StepSequenceState audioSequence;
    int               lastStepIndex = -1;
    bool              wasPlaying    = false;
    std::vector<PendingNoteOff> pendingNoteOffs;
    std::vector<PendingNoteOn>  pendingNoteOns;
    std::vector<int>            heldNotes;

    double currentSampleRate = 44100.0;
    double lastBeatPos       = 0.0;

    Dice dice;
};

} // namespace legacy
