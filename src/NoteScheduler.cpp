#include "NoteScheduler.h"

// Placeholder bodies so the scaffold links. Unit C replaces this file.
namespace seq
{

NoteScheduler::NoteScheduler() = default;

void NoteScheduler::prepare (double newSampleRate) noexcept { sampleRate = newSampleRate; }
void NoteScheduler::handle (const ImmediateEvent&, EventBuffer&) noexcept {}
void NoteScheduler::advance (int, EventBuffer&) noexcept {}
void NoteScheduler::releaseAll (EventBuffer&, int) noexcept {}
bool NoteScheduler::anyHeld() const noexcept { return false; }

} // namespace seq
