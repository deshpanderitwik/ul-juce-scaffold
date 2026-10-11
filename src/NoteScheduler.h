#pragma once

#include "StepSequencer.h"

// =============================================================================
// NoteScheduler — immediate (unquantized) notes sent from the web view.
//
// The UI can die at any moment (page reload, editor closed), so note lengths
// and "what is currently held" live here, on the AUDIO thread, not in JS.
// No JUCE dependency; no allocation, locks or I/O.
//
// Per block the processor calls, in this order:
//     handle()  for each event drained from the UI queue   (lands at sample 0)
//     advance() once                                        (expires gated notes)
// =============================================================================
namespace seq
{

struct ImmediateEvent
{
    enum Type : uint8_t
    {
        NoteOn,        // held until a matching NoteOff
        NoteOff,
        Note,          // on now, off after durationMs
        AllNotesOff    // release everything this scheduler has on
    };

    Type    type       = NoteOn;
    uint8_t note       = 60;      // 0-127
    uint8_t velocity   = 100;     // 1-127 (ignored for NoteOff / AllNotesOff)
    uint8_t channel    = 1;       // 1-16
    float   durationMs = 0.0f;    // Note only
};

class NoteScheduler
{
public:
    NoteScheduler();

    void prepare (double sampleRate) noexcept;

    // Apply one UI event at the start of the current block.
    // A NoteOn / Note for a (channel, note) that is already sounding emits its
    // note-off first, then the new note-on, and replaces any running gate.
    void handle (const ImmediateEvent& event, EventBuffer& out) noexcept;

    // Move time forward by one block. Gated notes whose length ends inside the
    // block get their note-off at the right sample offset.
    void advance (int numSamples, EventBuffer& out) noexcept;

    // Note-off for every note this scheduler has on. Nothing is held afterwards.
    void releaseAll (EventBuffer& out, int sampleOffset = 0) noexcept;

    bool anyHeld() const noexcept;

private:
    struct Impl;   // replace with real members — this is a placeholder
    double sampleRate = 44100.0;
};

} // namespace seq
