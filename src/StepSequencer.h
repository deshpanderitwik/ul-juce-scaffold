#pragma once

#include <array>
#include <cstdint>

// =============================================================================
// StepSequencer — the sample-accurate step sequencer, with no JUCE dependency.
//
// Everything here runs on the AUDIO thread: no allocation, no locks, no I/O.
// The processor owns the thread hand-off (it passes a freshly posted Sequence
// into process()) and copies the MIDI this class emits into the host's
// MidiBuffer.
//
// The public interface below is the contract between the sequencer, the
// processor and the tests. Private members are an implementation detail.
// =============================================================================
namespace seq
{

inline constexpr int kMaxSteps             = 256;    // longest sequence
inline constexpr int kMaxNotesPerStep      = 48;     // largest chord
inline constexpr int kMaxPending           = 128;    // pending note-offs / phrased note-ons
inline constexpr int kMaxEventsPerBlock    = 1024;   // MIDI events one block can emit
inline constexpr int kMaxStepEventsPerBlock = 32;    // step boundaries one block can report

// A note within a step. delay phrases the note later into its step: it
// triggers at boundary + delay * stepSize (0 = exactly on the boundary).
// probability gates each hit: 1 always plays, 0 never, in between the dice
// are rolled fresh every time the step comes around.
struct StepNote
{
    double  delay       = 0.0;   // fraction of one step, [0, 1)
    float   probability = 1.0f;  // chance this note triggers, [0, 1]
    uint8_t note        = 60;    // MIDI note, 0-127
    uint8_t velocity    = 100;   // MIDI velocity, 1-127
};

// One step: the notes to trigger together. numNotes == 0 is a silent step
// that still keeps its slot in the cycle.
struct Step
{
    int numNotes = 0;
    std::array<StepNote, kMaxNotesPerStep> notes {};
};

// A whole sequence. Large (~200 KB) — keep it on the heap or as a member,
// never on the stack.
struct Sequence
{
    int    numSteps     = 0;
    double stepsPerBeat = 2.0;     // may be fractional: 0.25 = one step per 4/4 bar
    double gateMs       = 150.0;   // note length; capped at one full step
    bool   legato       = false;   // sustain across boundaries, send only the chord diff
    int    tag          = 0;       // opaque owner id from the UI, echoed in StepEvents

    std::array<Step, kMaxSteps> steps {};

    // Copies the header and only the steps in use.
    void copyFrom (const Sequence& other) noexcept;
};

// What the host told us about this block.
struct BlockInfo
{
    double beatPos    = 0.0;      // ppq position of the block's first sample
    double bpm        = 120.0;
    bool   playing    = false;
    double sampleRate = 44100.0;
    int    numSamples = 0;

    // Valid host loop points (looping == false means "unknown / not looping").
    bool   looping   = false;
    double loopStart = 0.0;
    double loopEnd   = 0.0;
};

struct MidiEvent
{
    int     sampleOffset = 0;     // [0, numSamples)
    uint8_t note         = 60;
    uint8_t velocity     = 0;     // 0 for note-offs
    uint8_t channel      = 1;     // 1-16
    bool    on           = false;
};

// Fixed-capacity output list. Capacities are sized so a block cannot fill
// one in practice; a push onto a full buffer is ignored and returns false.
template <typename T, int Capacity>
struct FixedBuffer
{
    int count = 0;
    std::array<T, Capacity> items {};

    bool push (const T& item) noexcept
    {
        if (count >= Capacity)
            return false;
        items[static_cast<size_t> (count++)] = item;
        return true;
    }

    void clear() noexcept                              { count = 0; }
    const T& operator[] (int i) const noexcept         { return items[static_cast<size_t> (i)]; }
    const T* begin() const noexcept                    { return items.data(); }
    const T* end()   const noexcept                    { return items.data() + count; }
};

using EventBuffer = FixedBuffer<MidiEvent, kMaxEventsPerBlock>;

// Reported once per step boundary while the transport plays — including when
// the sequence is empty, so the UI has one clock to follow.
struct StepEvent
{
    int    index        = 0;      // absolute step number: boundary beat * stepsPerBeat
    double stepsPerBeat = 2.0;    // rate this boundary was computed at
    int    tag          = 0;      // tag of the sequence in effect
    int    numPlayed    = 0;      // notes that passed the dice (phrased ones included)
    std::array<uint8_t, kMaxNotesPerStep> played {};
};

using StepEventBuffer = FixedBuffer<StepEvent, kMaxStepEventsPerBlock>;

class StepSequencer
{
public:
    StepSequencer();

    // Seed the probability dice (tests use this for repeatable runs).
    void setSeed (uint64_t seed) noexcept;

    // Process one block.
    //   newSequence — non-null when the UI posted a sequence since the last
    //                 block; it is copied in and becomes current.
    //   out         — MIDI for this block is APPENDED (caller clears).
    //   steps       — step boundaries crossed in this block are APPENDED.
    void process (const BlockInfo& block,
                  const Sequence*  newSequence,
                  EventBuffer&     out,
                  StepEventBuffer& steps) noexcept;

    // Note-off for everything this sequencer has sounding, drop phrased notes
    // that have not fired, and forget the step position. Keeps the sequence.
    void flush (EventBuffer& out, int sampleOffset = 0) noexcept;

    const Sequence& sequence() const noexcept;

private:
    struct Impl;   // replace with real members — this is a placeholder
    Sequence current;
};

} // namespace seq
