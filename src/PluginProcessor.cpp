#include "PluginProcessor.h"
#include "PluginEditor.h"
#include <algorithm>

// =============================================================================
// Constructor — declare a stereo output bus (required for a synth plugin).
// We never actually produce audio, but the bus must exist so the DAW
// allocates a channel strip and routes our MIDI output.
// =============================================================================
PluginProcessor::PluginProcessor()
    : AudioProcessor (BusesProperties()
                        .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
}

PluginProcessor::~PluginProcessor() {}

// =============================================================================
// Identity — these come from the CMakeLists.txt plugin declaration.
// =============================================================================
const juce::String PluginProcessor::getName() const        { return JucePlugin_Name; }
bool   PluginProcessor::acceptsMidi()  const               { return true;  }
bool   PluginProcessor::producesMidi() const               { return true;  }
bool   PluginProcessor::isMidiEffect() const               { return false; }
double PluginProcessor::getTailLengthSeconds() const       { return 0.0;   }

// =============================================================================
// Programs — we don't use presets, but JUCE requires these overrides.
// Returning 1 program avoids confusing some hosts.
// =============================================================================
int  PluginProcessor::getNumPrograms()                     { return 1; }
int  PluginProcessor::getCurrentProgram()                  { return 0; }
void PluginProcessor::setCurrentProgram (int)              {}
const juce::String PluginProcessor::getProgramName (int)   { return {}; }
void PluginProcessor::changeProgramName (int, const juce::String&) {}

// =============================================================================
// Prepare / Release
// =============================================================================
void PluginProcessor::prepareToPlay (double sampleRate, int /*samplesPerBlock*/)
{
    currentSampleRate = sampleRate;

    // Pre-allocate so the audio thread never grows these mid-playback.
    pendingNoteOffs.reserve (kMidiQueueCapacity);
    heldNotes.reserve (kMidiQueueCapacity);
    audioSequence.steps.reserve (256);
}

void PluginProcessor::releaseResources() {}

// =============================================================================
// Bus layout — we only support stereo out.
// =============================================================================
bool PluginProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}

// =============================================================================
// processBlock — the heart of the audio thread.  Four jobs:
//   1. Output silence.
//   2. Read the host playhead → store in atomic TransportState.
//   3. Run the step sequencer (sample-accurate MIDI generation).
//   4. Drain the lock-free MIDI queue → write into the output MidiBuffer.
// =============================================================================
void PluginProcessor::processBlock (juce::AudioBuffer<float>& buffer,
                                    juce::MidiBuffer& midiMessages)
{
    // ---- 1. Silence --------------------------------------------------------
    buffer.clear();

    // ---- 2. Read playhead --------------------------------------------------
    double beatPos  = 0.0;
    double bpm      = 120.0;
    bool   playing  = false;

    if (auto* playhead = getPlayHead())
    {
        if (auto pos = playhead->getPosition())
        {
            if (auto b = pos->getBpm())
            {
                bpm = *b;
                transportState.bpm.store (bpm, std::memory_order_relaxed);
            }

            if (auto ppq = pos->getPpqPosition())
            {
                beatPos = *ppq;
                transportState.beatPosition.store (beatPos, std::memory_order_relaxed);
            }

            playing = pos->getIsPlaying();
            transportState.isPlaying.store (playing, std::memory_order_relaxed);

            if (auto ts = pos->getTimeSignature())
            {
                transportState.timeSigNumerator.store   (ts->numerator,   std::memory_order_relaxed);
                transportState.timeSigDenominator.store (ts->denominator, std::memory_order_relaxed);
            }
        }
    }

    // ---- 3. Step sequencer (sample-accurate) -------------------------------
    midiMessages.clear();

    const int numSamples = buffer.getNumSamples();

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
                    juce::MidiMessage::noteOff (noff.channel, noff.note, static_cast<juce::uint8> (0)), 0);
            pendingNoteOffs.clear();

            for (int held : heldNotes)
                midiMessages.addEvent (
                    juce::MidiMessage::noteOff (1, held, static_cast<juce::uint8> (0)), 0);
            heldNotes.clear();
        }
        lastBeatPos = bufferEndBeat;

        // Refresh the audio-side copy only when the message thread has posted
        // a new sequence — the copy may allocate, but only on user edits, not
        // every block. Try-lock so we never spin against the message thread;
        // if it's mid-write we just pick the update up next block.
        if (sequenceDirty.load (std::memory_order_acquire))
        {
            const juce::SpinLock::ScopedTryLockType tryLock (sequenceLock);
            if (tryLock.isLocked())
            {
                audioSequence = sequenceState;
                sequenceDirty.store (false, std::memory_order_relaxed);
            }
        }
        const StepSequenceState& seq = audioSequence;

        // If legato notes are ringing but the sequence can no longer sustain
        // them (cleared, or replaced by a non-legato one), release them now.
        if ((seq.steps.empty() || ! seq.legato) && ! heldNotes.empty())
        {
            for (int held : heldNotes)
                midiMessages.addEvent (
                    juce::MidiMessage::noteOff (1, held, static_cast<juce::uint8> (0)), 0);
            heldNotes.clear();
        }

        // Process pending note-offs BEFORE new note-ons so that when the same
        // MIDI note has a note-off and note-on at the same sample, the off clears first.
        for (auto it = pendingNoteOffs.begin(); it != pendingNoteOffs.end(); )
        {
            if (it->beatPosition <= bufferEndBeat)
            {
                int sampleOffset = static_cast<int> (
                    (it->beatPosition - beatPos) / beatsPerSample);
                sampleOffset = juce::jlimit (0, numSamples - 1, sampleOffset);

                midiMessages.addEvent (
                    juce::MidiMessage::noteOff (it->channel, it->note, static_cast<juce::uint8> (0)),
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
            const double durationBeats = juce::jlimit (0.01, stepSize,
                seq.noteDurationMs * 0.001 * (bpm / 60.0));

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
                sampleOffset = juce::jlimit (0, numSamples - 1, sampleOffset);

                const int numSteps = static_cast<int> (seq.steps.size());
                int stepIndex = ((s % numSteps) + numSteps) % numSteps;
                const auto& chord = seq.steps[static_cast<size_t> (stepIndex)];

                if (seq.legato)
                {
                    // Diff transition: release held notes leaving the chord...
                    for (auto it = heldNotes.begin(); it != heldNotes.end(); )
                    {
                        if (std::find (chord.begin(), chord.end(), *it) == chord.end())
                        {
                            midiMessages.addEvent (
                                juce::MidiMessage::noteOff (1, *it, static_cast<juce::uint8> (0)),
                                sampleOffset);
                            it = heldNotes.erase (it);
                        }
                        else
                        {
                            ++it;
                        }
                    }

                    // ...start notes entering it; notes in both keep ringing.
                    for (int note : chord)
                    {
                        if (std::find (heldNotes.begin(), heldNotes.end(), note) == heldNotes.end())
                        {
                            midiMessages.addEvent (
                                juce::MidiMessage::noteOn (1, note, static_cast<juce::uint8> (100)),
                                sampleOffset);
                            heldNotes.push_back (note);
                        }
                    }
                }
                else
                {
                    for (int note : chord)
                    {
                        midiMessages.addEvent (
                            juce::MidiMessage::noteOn (1, note, static_cast<juce::uint8> (100)),
                            sampleOffset);

                        pendingNoteOffs.push_back ({ note, 1, boundaryBeat + durationBeats });
                    }
                }
                lastStepIndex = s;
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
                    juce::MidiMessage::noteOff (noff.channel, noff.note, static_cast<juce::uint8> (0)),
                    0);
            }
            pendingNoteOffs.clear();

            for (int held : heldNotes)
            {
                midiMessages.addEvent (
                    juce::MidiMessage::noteOff (1, held, static_cast<juce::uint8> (0)),
                    0);
            }
            heldNotes.clear();
        }
        lastStepIndex = -1;
    }

    wasPlaying = playing;

    // ---- 4. Drain MIDI queue (immediate events from JS) --------------------
    const int numReady = midiFifo.getNumReady();
    if (numReady > 0)
    {
        const auto scope = midiFifo.read (numReady);

        for (int i = 0; i < scope.blockSize1; ++i)
        {
            const auto& evt = midiQueue[static_cast<size_t> (scope.startIndex1 + i)];

            if (evt.type == MidiEventData::NoteOn)
                midiMessages.addEvent (
                    juce::MidiMessage::noteOn  (evt.channel, evt.note, static_cast<juce::uint8> (evt.velocity)), 0);
            else
                midiMessages.addEvent (
                    juce::MidiMessage::noteOff (evt.channel, evt.note, static_cast<juce::uint8> (0)), 0);
        }

        for (int i = 0; i < scope.blockSize2; ++i)
        {
            const auto& evt = midiQueue[static_cast<size_t> (scope.startIndex2 + i)];

            if (evt.type == MidiEventData::NoteOn)
                midiMessages.addEvent (
                    juce::MidiMessage::noteOn  (evt.channel, evt.note, static_cast<juce::uint8> (evt.velocity)), 0);
            else
                midiMessages.addEvent (
                    juce::MidiMessage::noteOff (evt.channel, evt.note, static_cast<juce::uint8> (0)), 0);
        }
    }
}

// =============================================================================
// setStepSequence — called from the MESSAGE thread to update the sequence.
// =============================================================================
void PluginProcessor::setStepSequence (std::vector<std::vector<int>> steps, double multiplier, double durationMs, bool legato)
{
    {
        const juce::SpinLock::ScopedLockType lock (sequenceLock);
        sequenceState.steps                  = std::move (steps);
        sequenceState.subdivisionMultiplier  = multiplier;
        sequenceState.noteDurationMs         = durationMs;
        sequenceState.legato                 = legato;
    }
    sequenceDirty.store (true, std::memory_order_release);
}

// =============================================================================
// pushMidiEvent — called from the MESSAGE thread by the web view callback.
// Writes one event into the lock-free ring buffer.
// If the queue is full, the event is silently dropped (better than blocking).
// =============================================================================
void PluginProcessor::pushMidiEvent (const MidiEventData& event)
{
    const auto scope = midiFifo.write (1);

    if (scope.blockSize1 > 0)
        midiQueue[static_cast<size_t> (scope.startIndex1)] = event;
    else if (scope.blockSize2 > 0)
        midiQueue[static_cast<size_t> (scope.startIndex2)] = event;
}

// =============================================================================
// Editor
// =============================================================================
bool PluginProcessor::hasEditor() const { return true; }

juce::AudioProcessorEditor* PluginProcessor::createEditor()
{
    return new PluginEditor (*this);
}

// =============================================================================
// Web state — JSON blobs keyed by experiment id, saved with the DAW project.
// =============================================================================
void PluginProcessor::setWebState (const juce::String& key, const juce::String& json)
{
    const juce::ScopedLock lock (stateLock);
    webState[key] = json;
}

juce::var PluginProcessor::getWebStateAsVar() const
{
    auto* obj = new juce::DynamicObject();
    {
        const juce::ScopedLock lock (stateLock);
        for (const auto& [key, json] : webState)
            obj->setProperty (key, json);
    }
    return juce::var (obj);
}

void PluginProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto jsonStr = juce::JSON::toString (getWebStateAsVar(), true);
    destData.replaceAll (jsonStr.toRawUTF8(), jsonStr.getNumBytesAsUTF8());
}

void PluginProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto parsed = juce::JSON::parse (
        juce::String::fromUTF8 (static_cast<const char*> (data), sizeInBytes));

    if (auto* obj = parsed.getDynamicObject())
    {
        const juce::ScopedLock lock (stateLock);
        webState.clear();
        for (const auto& prop : obj->getProperties())
            webState[prop.name.toString()] = prop.value.toString();
    }
}

// =============================================================================
// This free function is how JUCE discovers our processor.
// The DAW calls this to create a plugin instance.
// =============================================================================
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new PluginProcessor();
}
