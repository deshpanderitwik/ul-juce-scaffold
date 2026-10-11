#pragma once

#include "NoteScheduler.h"
#include "StepSequencer.h"
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <array>
#include <atomic>
#include <map>
#include <memory>

// =============================================================================
// Transport state — written on the AUDIO thread, read on the MESSAGE thread.
// Each field is independently atomic.  We use relaxed ordering because
// a one-frame inconsistency between fields is harmless for a UI display.
// =============================================================================
struct TransportState
{
    std::atomic<double> bpm            { 120.0 };
    std::atomic<double> beatPosition   { 0.0 };
    std::atomic<bool>   isPlaying      { false };
    std::atomic<int>    timeSigNumerator   { 4 };
    std::atomic<int>    timeSigDenominator { 4 };
};

// =============================================================================
// The AudioProcessor — our thin host layer.
//
// The step sequence plays from here, not from the page: it is saved with the
// project and restored into the audio thread by setStateInformation, so a
// reopened project sounds without the editor ever having been opened. The
// editor only mirrors what the sequencer did (step events) and feeds it new
// sequences and immediate notes.
// =============================================================================
class PluginProcessor : public juce::AudioProcessor,
                        public juce::ChangeBroadcaster
{
public:
    PluginProcessor();
    ~PluginProcessor() override;

    // --- Audio processing ---
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    void processBlockBypassed (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;

    // --- Editor ---
    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    // --- Plugin identity ---
    const juce::String getName() const override;
    bool   acceptsMidi()  const override;
    bool   producesMidi() const override;
    bool   isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    // --- Programs (unused, but required overrides) ---
    int  getNumPrograms() override;
    int  getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    // --- State persistence ---
    // The saved project holds the web state and the last step sequence the
    // page sent (see bridge::PluginState). The host may call these from any
    // non-audio thread. After a restore the processor sends a change message
    // so an open editor can hand the new web state to its page.
    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // ==========================================================================
    // Our custom interface (MESSAGE thread unless noted)
    // ==========================================================================

    // Immediate (unquantized) notes. One ordered queue; if it is full a NoteOn
    // is dropped, and anything else makes the audio thread release every note,
    // because a lost note-off would leave a note stuck.
    void pushImmediate (const seq::ImmediateEvent& event);

    // Parses a `setStepSequence` payload and hands it to the audio thread.
    // Returns false, changing nothing, if the payload is not valid.
    bool setStepSequence (const juce::var& payload);

    // --- Web state ---
    // Arbitrary JSON blobs keyed by experiment id, saved with the project.
    // Marks the project as modified in the host.
    void setWebState (const juce::String& key, const juce::String& json);
    std::map<juce::String, juce::String> getWebState() const;

    // --- Page / editor lifecycle ---
    // The page (re)loaded: whatever it had sounding is gone, so release it.
    // The step sequence is left alone.
    void pageLoaded();

    // The editor wants step events. Whatever is still queued from an earlier
    // editor is discarded.
    void editorAttached();

    // The editor is closing: stop queueing step events and release the notes
    // the page may have been holding. The step sequence keeps playing.
    void editorDetached();

    // Moves up to maxEvents step events, oldest first, into dest.
    int popStepEvents (seq::StepEvent* dest, int maxEvents);

    // Readable from any thread (each field is atomic).
    TransportState transport;

    static constexpr int kImmediateQueueCapacity = 256;
    static constexpr int kStepQueueCapacity      = 128;

private:
    // Fills the block description from the host playhead and publishes the
    // transport to the UI.
    void readPlayhead (seq::BlockInfo& block);

    void drainImmediateQueue();

    // Message side of the sequence hand-off. Caller holds stateLock.
    void publishSequence (const seq::Sequence& sequence);

    // Sequence hand-off: the message thread fills `pending` under the spin lock
    // and sets the dirty flag; the audio thread copies it into `staging` with a
    // try-lock and passes that to the sequencer. A Sequence is ~200 KB, so all
    // three live on the heap, allocated here and never on the audio thread.
    std::unique_ptr<seq::Sequence> scratch  { std::make_unique<seq::Sequence>() };
    std::unique_ptr<seq::Sequence> pending  { std::make_unique<seq::Sequence>() };
    std::unique_ptr<seq::Sequence> staging  { std::make_unique<seq::Sequence>() };
    juce::SpinLock                 sequenceLock;
    std::atomic<bool>              sequenceDirty { false };

    seq::StepSequencer  sequencer;
    seq::NoteScheduler  scheduler;
    seq::EventBuffer    events;
    seq::StepEventBuffer stepEvents;

    // Immediate notes: message thread -> audio thread.
    juce::AbstractFifo                                          immediateFifo { kImmediateQueueCapacity };
    std::array<seq::ImmediateEvent, kImmediateQueueCapacity>    immediateQueue;
    std::atomic<bool>                                           panic { false };

    // Step events: audio thread -> editor timer. Only filled while an editor
    // is attached, and dropped when full.
    juce::AbstractFifo                                          stepFifo { kStepQueueCapacity };
    std::array<seq::StepEvent, kStepQueueCapacity>              stepQueue;
    std::atomic<bool>                                           editorIsAttached { false };

    // prepareToPlay cannot emit MIDI and releaseResources cannot either, so
    // the first block after a prepare starts by ending whatever was sounding.
    std::atomic<bool>   releaseOnNextBlock { true };

    double currentSampleRate = 44100.0;

    // Saved state. stateLock also serialises the message-side sequence path,
    // since the host may call setStateInformation from a thread of its own.
    mutable juce::CriticalSection stateLock;
    std::map<juce::String, juce::String> webState;
    juce::var lastSequence;   // the last accepted setStepSequence payload

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginProcessor)
};
