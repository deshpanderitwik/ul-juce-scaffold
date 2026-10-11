#include "PluginProcessor.h"
#include "Bridge.h"
#include "PluginEditor.h"
#include <algorithm>
#include <cmath>

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
    scheduler.prepare (sampleRate);

    // Nothing can be sent from here or from releaseResources, and the host may
    // have been mid-note when it stopped and restarted us, so the first block
    // begins by ending everything this plugin had sounding.
    releaseOnNextBlock.store (true, std::memory_order_release);
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
// Audio thread helpers — nothing here allocates, locks or does I/O.
// =============================================================================
void PluginProcessor::readPlayhead (seq::BlockInfo& block)
{
    block.sampleRate = currentSampleRate;

    bool havePosition = false;

    if (auto* playhead = getPlayHead())
    {
        if (auto pos = playhead->getPosition())
        {
            havePosition = true;

            if (auto b = pos->getBpm(); b.hasValue() && std::isfinite (*b) && *b > 0.0)
            {
                block.bpm = *b;
                transport.bpm.store (block.bpm, std::memory_order_relaxed);
            }

            if (auto ppq = pos->getPpqPosition())
            {
                block.beatPos = *ppq;
                transport.beatPosition.store (block.beatPos, std::memory_order_relaxed);
            }

            block.playing = pos->getIsPlaying();
            transport.isPlaying.store (block.playing, std::memory_order_relaxed);

            // Loop points only count when the host is actually looping and
            // they describe a real range.
            if (pos->getIsLooping())
            {
                if (auto loop = pos->getLoopPoints(); loop.hasValue() && loop->ppqEnd > loop->ppqStart)
                {
                    block.looping   = true;
                    block.loopStart = loop->ppqStart;
                    block.loopEnd   = loop->ppqEnd;
                }
            }

            if (auto ts = pos->getTimeSignature())
            {
                transport.timeSigNumerator.store   (ts->numerator,   std::memory_order_relaxed);
                transport.timeSigDenominator.store (ts->denominator, std::memory_order_relaxed);
            }
        }
    }

    if (! havePosition)
        transport.isPlaying.store (false, std::memory_order_relaxed);
}

void PluginProcessor::drainImmediateQueue()
{
    const int numReady = immediateFifo.getNumReady();
    if (numReady <= 0)
        return;

    const auto scope = immediateFifo.read (numReady);

    for (int i = 0; i < scope.blockSize1; ++i)
        scheduler.handle (immediateQueue[static_cast<size_t> (scope.startIndex1 + i)], events);

    for (int i = 0; i < scope.blockSize2; ++i)
        scheduler.handle (immediateQueue[static_cast<size_t> (scope.startIndex2 + i)], events);
}

namespace
{
    // MidiBuffer keeps insertion order for events at the same sample, which is
    // what keeps a note-off ahead of the note-on that retriggers it.
    void appendTo (juce::MidiBuffer& midi, const seq::EventBuffer& events, int numSamples)
    {
        const int lastSample = std::max (numSamples - 1, 0);

        for (const auto& e : events)
        {
            const int offset = std::clamp (e.sampleOffset, 0, lastSample);

            if (e.on)
                midi.addEvent (juce::MidiMessage::noteOn (e.channel, e.note, static_cast<juce::uint8> (e.velocity)), offset);
            else
                midi.addEvent (juce::MidiMessage::noteOff (e.channel, e.note, static_cast<juce::uint8> (0)), offset);
        }
    }
}

// =============================================================================
// processBlock — the heart of the audio thread.
//   1. Output silence.
//   2. Read the host playhead (and publish it to the UI).
//   3. Run the step sequencer, fed by the newest posted sequence.
//   4. Run the immediate-note scheduler on the UI queue.
//   5. Write the MIDI out, and report the steps that played to the editor.
// =============================================================================
void PluginProcessor::processBlock (juce::AudioBuffer<float>& buffer,
                                    juce::MidiBuffer& midiMessages)
{
    buffer.clear();
    midiMessages.clear();

    events.clear();
    stepEvents.clear();

    seq::BlockInfo block;
    block.numSamples = buffer.getNumSamples();
    readPlayhead (block);

    if (releaseOnNextBlock.exchange (false, std::memory_order_acq_rel))
    {
        sequencer.flush (events, 0);
        scheduler.releaseAll (events, 0);
    }

    // A freshly posted sequence is taken with a try-lock so the audio thread
    // never waits on the message thread; if it is busy the next block retries.
    const seq::Sequence* incoming = nullptr;

    if (sequenceDirty.load (std::memory_order_acquire))
    {
        const juce::SpinLock::ScopedTryLockType tryLock (sequenceLock);

        if (tryLock.isLocked())
        {
            staging->copyFrom (*pending);
            sequenceDirty.store (false, std::memory_order_relaxed);
            incoming = staging.get();
        }
    }

    sequencer.process (block, incoming, events, stepEvents);

    // The flag is read before the queue so that every event pushed ahead of the
    // failed push is already visible when the queue is drained.
    const bool releaseEverything = panic.exchange (false, std::memory_order_acq_rel);
    drainImmediateQueue();

    if (releaseEverything)
        scheduler.releaseAll (events, 0);

    scheduler.advance (block.numSamples, events);

    appendTo (midiMessages, events, block.numSamples);

    if (editorIsAttached.load (std::memory_order_acquire) && stepEvents.count > 0)
    {
        const int toWrite = std::min (stepEvents.count, stepFifo.getFreeSpace());

        if (toWrite > 0)
        {
            const auto scope = stepFifo.write (toWrite);
            int next = 0;

            for (int i = 0; i < scope.blockSize1; ++i)
                stepQueue[static_cast<size_t> (scope.startIndex1 + i)] = stepEvents[next++];

            for (int i = 0; i < scope.blockSize2; ++i)
                stepQueue[static_cast<size_t> (scope.startIndex2 + i)] = stepEvents[next++];
        }
    }
}

// =============================================================================
// Bypass — the host stops calling processBlock, so end every note once and
// then stay silent. Both calls are no-ops once nothing is sounding.
// =============================================================================
void PluginProcessor::processBlockBypassed (juce::AudioBuffer<float>& buffer,
                                            juce::MidiBuffer& midiMessages)
{
    buffer.clear();
    midiMessages.clear();

    events.clear();
    stepEvents.clear();

    seq::BlockInfo block;
    block.numSamples = buffer.getNumSamples();
    readPlayhead (block);

    releaseOnNextBlock.store (false, std::memory_order_relaxed);
    sequencer.flush (events, 0);
    scheduler.releaseAll (events, 0);

    // Notes queued while bypassed are dropped rather than played late, after
    // the release above has already ended everything.
    panic.store (false, std::memory_order_relaxed);
    if (const int numReady = immediateFifo.getNumReady(); numReady > 0)
        immediateFifo.read (numReady);

    appendTo (midiMessages, events, block.numSamples);
}

// =============================================================================
// Immediate notes — MESSAGE thread to audio thread.
// =============================================================================
void PluginProcessor::pushImmediate (const seq::ImmediateEvent& event)
{
    {
        const auto scope = immediateFifo.write (1);

        if (scope.blockSize1 > 0)
        {
            immediateQueue[static_cast<size_t> (scope.startIndex1)] = event;
            return;
        }

        if (scope.blockSize2 > 0)
        {
            immediateQueue[static_cast<size_t> (scope.startIndex2)] = event;
            return;
        }
    }

    // A dropped note-on is only a missed note. Anything else could have been
    // the note-off a held note is waiting for.
    if (event.type != seq::ImmediateEvent::NoteOn)
        panic.store (true, std::memory_order_release);
}

// =============================================================================
// Step sequence — MESSAGE thread to audio thread.
// =============================================================================
void PluginProcessor::publishSequence (const seq::Sequence& sequence)
{
    const juce::SpinLock::ScopedLockType lock (sequenceLock);
    pending->copyFrom (sequence);
    sequenceDirty.store (true, std::memory_order_release);
}

bool PluginProcessor::setStepSequence (const juce::var& payload)
{
    const juce::ScopedLock lock (stateLock);

    if (! bridge::parseStepSequence (payload, *scratch))
        return false;

    publishSequence (*scratch);
    lastSequence = payload.clone();
    return true;
}

// =============================================================================
// Page and editor lifecycle
// =============================================================================
void PluginProcessor::pageLoaded()
{
    seq::ImmediateEvent release;
    release.type = seq::ImmediateEvent::AllNotesOff;
    pushImmediate (release);
}

void PluginProcessor::editorAttached()
{
    if (const int numReady = stepFifo.getNumReady(); numReady > 0)
        stepFifo.read (numReady);

    editorIsAttached.store (true, std::memory_order_release);
}

void PluginProcessor::editorDetached()
{
    editorIsAttached.store (false, std::memory_order_release);
    pageLoaded();
}

int PluginProcessor::popStepEvents (seq::StepEvent* dest, int maxEvents)
{
    const int count = std::min (stepFifo.getNumReady(), maxEvents);
    if (count <= 0)
        return 0;

    const auto scope = stepFifo.read (count);
    int next = 0;

    for (int i = 0; i < scope.blockSize1; ++i)
        dest[next++] = stepQueue[static_cast<size_t> (scope.startIndex1 + i)];

    for (int i = 0; i < scope.blockSize2; ++i)
        dest[next++] = stepQueue[static_cast<size_t> (scope.startIndex2 + i)];

    return count;
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
    {
        const juce::ScopedLock lock (stateLock);

        auto existing = webState.find (key);
        if (existing != webState.end() && existing->second == json)
            return;

        webState[key] = json;
    }

    // Without this the host has no way to know the project changed, and may
    // not offer to save it.
    updateHostDisplay (juce::AudioProcessor::ChangeDetails().withNonParameterStateChanged (true));
}

std::map<juce::String, juce::String> PluginProcessor::getWebState() const
{
    const juce::ScopedLock lock (stateLock);
    return webState;
}

void PluginProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    bridge::PluginState state;
    {
        const juce::ScopedLock lock (stateLock);
        state.web      = webState;
        state.sequence = lastSequence;
    }

    const auto json = bridge::serialiseState (state);
    destData.replaceAll (json.toRawUTF8(), json.getNumBytesAsUTF8());
}

void PluginProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    bridge::PluginState state;

    if (data == nullptr || sizeInBytes <= 0
        || ! bridge::parseState (juce::String::fromUTF8 (static_cast<const char*> (data), sizeInBytes), state))
        return;

    {
        const juce::ScopedLock lock (stateLock);

        webState = std::move (state.web);

        // A project without a sequence is an empty one, not "keep whatever
        // was playing".
        if (state.sequence.isVoid() || ! setStepSequence (state.sequence))
        {
            scratch->numSteps     = 0;
            scratch->stepsPerBeat = 2.0;
            scratch->gateMs       = 150.0;
            scratch->legato       = false;
            scratch->tag          = 0;

            publishSequence (*scratch);
            lastSequence = juce::var();
        }
    }

    sendChangeMessage();
}

// =============================================================================
// This free function is how JUCE discovers our processor.
// The DAW calls this to create a plugin instance.
// =============================================================================
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new PluginProcessor();
}
