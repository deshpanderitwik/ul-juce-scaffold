#include "NoteScheduler.h"

#include <algorithm>
#include <cmath>

namespace seq
{

namespace
{
    // A gate this long is "held" for any practical purpose; the cap keeps the
    // sample count inside an int.
    constexpr double kMaxGateSamples = 1073741824.0;

    MidiEvent makeEvent (int sampleOffset, int channel, int note, int velocity, bool on) noexcept
    {
        MidiEvent e;
        e.sampleOffset = sampleOffset;
        e.note         = static_cast<uint8_t> (note);
        e.velocity     = static_cast<uint8_t> (velocity);
        e.channel      = static_cast<uint8_t> (channel);
        e.on           = on;
        return e;
    }
}

NoteScheduler::NoteScheduler() = default;

void NoteScheduler::prepare (double newSampleRate) noexcept
{
    if (newSampleRate > 0.0)
        sampleRate = newSampleRate;
}

int NoteScheduler::gateInSamples (float durationMs) const noexcept
{
    // At least one sample, so the note-off always lands after its note-on.
    if (! (durationMs > 0.0f))
        return 1;

    const double samples = static_cast<double> (durationMs) * 0.001 * sampleRate;
    return static_cast<int> (std::clamp (std::round (samples), 1.0, kMaxGateSamples));
}

bool NoteScheduler::release (int slot, EventBuffer& out, int sampleOffset) noexcept
{
    const auto index = static_cast<size_t> (slot);

    if (state[index] == State::Off)
        return true;

    if (! out.push (makeEvent (sampleOffset, channelOf (slot), noteOf (slot), 0, false)))
    {
        state[index]     = State::Gated;
        remaining[index] = 0;
        return false;
    }

    state[index]     = State::Off;
    remaining[index] = 0;
    --numOn;
    return true;
}

void NoteScheduler::handle (const ImmediateEvent& event, EventBuffer& out) noexcept
{
    if (event.type == ImmediateEvent::AllNotesOff)
    {
        releaseAll (out, 0);
        return;
    }

    const int channel = std::clamp (static_cast<int> (event.channel), 1, kNumChannels);
    const int note    = std::clamp (static_cast<int> (event.note), 0, kNumNotes - 1);
    const int slot    = slotFor (channel, note);
    const auto index  = static_cast<size_t> (slot);

    if (event.type == ImmediateEvent::NoteOff)
    {
        release (slot, out, 0);
        return;
    }

    // The same pitch again: the old note ends first, so a retrigger is always
    // off-then-on and the host never sees two overlapping note-ons.
    if (state[index] != State::Off && ! release (slot, out, 0))
        return;

    const int velocity = std::clamp (static_cast<int> (event.velocity), 1, 127);

    if (! out.push (makeEvent (0, channel, note, velocity, true)))
        return;   // never started, so there is nothing to end later

    ++numOn;

    if (event.type == ImmediateEvent::Note)
    {
        state[index]     = State::Gated;
        remaining[index] = gateInSamples (event.durationMs);
    }
    else
    {
        state[index]     = State::Held;
        remaining[index] = 0;
    }
}

void NoteScheduler::advance (int numSamples, EventBuffer& out) noexcept
{
    if (numOn == 0 || numSamples <= 0)
        return;

    for (int slot = 0; slot < kNumSlots; ++slot)
    {
        const auto index = static_cast<size_t> (slot);

        if (state[index] != State::Gated)
            continue;

        if (remaining[index] < numSamples)
            release (slot, out, std::max (remaining[index], 0));
        else
            remaining[index] -= numSamples;
    }
}

void NoteScheduler::releaseAll (EventBuffer& out, int sampleOffset) noexcept
{
    if (numOn == 0)
        return;

    for (int slot = 0; slot < kNumSlots; ++slot)
        release (slot, out, sampleOffset);
}

bool NoteScheduler::anyHeld() const noexcept
{
    return numOn > 0;
}

} // namespace seq
