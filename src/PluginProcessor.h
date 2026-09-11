#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <array>
#include <atomic>
#include <map>
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
// A note within a step. delay phrases the note later into its step: it
// triggers at boundary + delay * stepSize (0 = exactly on the boundary).
// probability gates each hit: 1 always plays, 0 never, in between the
// dice are rolled fresh every time the step comes around.
struct StepNote
{
    int    note        = 60;
    double delay       = 0.0;   // fraction of one step, [0, 1)
    double probability = 1.0;   // chance this note triggers, [0, 1]
};

struct StepSequenceState
{
    // One entry per step; each step holds the notes to trigger together.
    // A single-note step is a one-element vector; an empty vector is a
    // silent step (keeps its slot in the cycle).
    std::vector<std::vector<StepNote>> steps;

    // Steps per beat. May be fractional: 0.5 = half-note steps, 0.25 = one
    // step per 4/4 bar.
    double subdivisionMultiplier = 2.0;
    double noteDurationMs        = 150.0;

    // Legato mode: notes sustain across step boundaries. At each boundary
    // only the diff is sent — notes leaving the chord get note-offs, notes
    // entering get note-ons, notes present in both keep ringing.
    // noteDurationMs and per-note delays are ignored in this mode.
    bool legato = false;
};

struct PendingNoteOff
{
    int    note         = 60;
    int    channel      = 1;
    double beatPosition = 0.0;
};

// A phrased (delayed) note waiting for its trigger beat.
struct PendingNoteOn
{
    int    note         = 60;
    int    channel      = 1;
    double beatPosition = 0.0;   // when to trigger
    double gateBeats    = 0.5;   // note length once triggered
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
    void setStepSequence (std::vector<std::vector<StepNote>> steps, double multiplier, double durationMs, bool legato);

    // --- Web state ---
    // Arbitrary JSON blobs keyed by experiment id, round-tripped through
    // get/setStateInformation so they persist in the DAW project (and
    // survive the editor being closed and reopened). The host may call the
    // state callbacks from any thread, so access is locked.
    void setWebState (const juce::String& key, const juce::String& json);
    juce::var getWebStateAsVar() const;   // { key: jsonString, ... }

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
    std::atomic<bool>      sequenceDirty { false };
    StepSequenceState      audioSequence;   // audio-thread copy, refreshed only when dirty
    int                    lastStepIndex = -1;
    bool                   wasPlaying    = false;
    std::vector<PendingNoteOff> pendingNoteOffs;
    std::vector<PendingNoteOn>  pendingNoteOns;   // phrased notes awaiting their beat
    std::vector<int>       heldNotes;   // notes currently sustained by legato mode

    double currentSampleRate = 44100.0;
    double lastBeatPos       = 0.0;

    juce::Random random;   // audio-thread dice for note probability

    // Web state store (see setWebState)
    mutable juce::CriticalSection stateLock;
    std::map<juce::String, juce::String> webState;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginProcessor)
};
