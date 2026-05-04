#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <array>
#include <atomic>
#include <vector>

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
// A single MIDI event from the web view.
// Pushed by the message thread, consumed by the audio thread.
// =============================================================================
struct MidiEventData
{
    enum Type { NoteOn, NoteOff };

    Type type     = NoteOn;
    int  note     = 60;
    int  velocity = 127;
    int  channel  = 1;
};

// =============================================================================
// Step sequence state — written on the MESSAGE thread, read on the AUDIO thread.
// Protected by a SpinLock (brief hold times, no allocation under lock).
// =============================================================================
struct StepSequenceState
{
    std::vector<int> notes;
    int  subdivisionMultiplier = 2;
    double noteDurationMs      = 150.0;
};

struct PendingNoteOff
{
    int    note         = 60;
    int    channel      = 1;
    double beatPosition = 0.0;
};

// =============================================================================
// The AudioProcessor — our thin host layer.
// =============================================================================
class PluginProcessor : public juce::AudioProcessor
{
public:
    PluginProcessor();
    ~PluginProcessor() override;

    // --- Audio processing ---
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
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

    // --- State persistence (empty for now) ---
    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // ==========================================================================
    // Our custom interface
    // ==========================================================================

    // Call from the MESSAGE thread to enqueue a MIDI event for the audio thread.
    void pushMidiEvent (const MidiEventData& event);

    // Call from the MESSAGE thread to update the step sequence.
    void setStepSequence (std::vector<int> notes, int multiplier, double durationMs);

    // Readable from any thread (each field is atomic).
    TransportState transportState;

    // Unique per DAW session — generated once in the constructor.
    const juce::String sessionId { juce::Uuid().toString() };

private:
    // Lock-free MIDI queue: single-producer (message thread), single-consumer (audio thread)
    static constexpr int kMidiQueueCapacity = 256;
    juce::AbstractFifo                            midiFifo  { kMidiQueueCapacity };
    std::array<MidiEventData, kMidiQueueCapacity> midiQueue;

    // Step sequencer state (message thread writes, audio thread reads)
    juce::SpinLock         sequenceLock;
    StepSequenceState      sequenceState;
    int                    lastStepIndex = -1;
    bool                   wasPlaying    = false;
    std::vector<PendingNoteOff> pendingNoteOffs;

    double currentSampleRate = 44100.0;
    double lastBeatPos       = 0.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginProcessor)
};
