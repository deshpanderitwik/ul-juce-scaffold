#include "StepSequencer.h"
#include <cmath>

namespace seq
{

namespace
{
    constexpr uint8_t kChannel = 1;

    size_t idx (int i) noexcept                          { return static_cast<size_t> (i); }

    // Same result as juce::jlimit, and no undefined behaviour if lo > hi.
    double limit (double lo, double hi, double v) noexcept
    {
        return v < lo ? lo : (hi < v ? hi : v);
    }

    int wrapIndex (int s, int n) noexcept                { return ((s % n) + n) % n; }

    // Truncating conversion that cannot overflow on absurd host positions.
    int toInt (double v) noexcept
    {
        constexpr double kLimit = 1.0e9;

        if (! (v == v))
            return 0;
        return static_cast<int> (v < -kLimit ? -kLimit : (v > kLimit ? kLimit : v));
    }

    // A block whose start is further than this from where the previous one
    // ended is a jump. It has to be wide enough for a host that integrates a
    // tempo ramp inside the block while we extrapolate with the block-start
    // tempo.
    constexpr double kJumpTolerance = 1.0 / 64.0;

    // Blocks longer than the loop can wrap more than once; this bounds the work.
    constexpr int kMaxWrapsPerBlock = 8;

    // Bounds the boundary loop against absurd rates; a real block never comes close.
    constexpr long long kMaxStepsPerSegment = 4096;

    MidiEvent makeNoteOn (int sampleOffset, uint8_t note, uint8_t velocity) noexcept
    {
        MidiEvent e;
        e.sampleOffset = sampleOffset;
        e.note         = note;
        e.velocity     = velocity;
        e.channel      = kChannel;
        e.on           = true;
        return e;
    }

    MidiEvent makeNoteOff (int sampleOffset, uint8_t note) noexcept
    {
        MidiEvent e;
        e.sampleOffset = sampleOffset;
        e.note         = note;
        e.velocity     = 0;
        e.channel      = kChannel;
        e.on           = false;
        return e;
    }

    // The beat at which `step`'s note with `delay` triggers. A capped note-off
    // has to be the very same double as the trigger it ends at, or the two can
    // truncate to different samples and the old note's off lands after the new
    // note's on. Every trigger beat and every capped off beat comes from here.
    // std::fma, because a compiler that contracts a * b + c at one call site and
    // not at another would hand out two different doubles for the same beat.
    double triggerBeatOf (int step, double delay, double stepSize) noexcept
    {
        const double boundary = static_cast<double> (step) * stepSize;

        return delay > 0.0 ? std::fma (delay, stepSize, boundary) : boundary;
    }

    // The beat at which a note triggered at `triggerBeat` of `step` ends. A gate
    // at the cap ends exactly where the same phrasing of the next step triggers.
    double offBeatOf (int step, double delay, double stepSize, double triggerBeat,
                      double gateBeats) noexcept
    {
        return gateBeats >= stepSize ? triggerBeatOf (step + 1, delay, stepSize)
                                     : triggerBeat + gateBeats;
    }

    // A saved sequence passes through JSON text with about 15 significant
    // digits, so the same delay or gate comes back a few ulps away from the
    // page's. No edit is that small.
    bool sameValue (double a, double b) noexcept
    {
        constexpr double kTolerance = 1.0e-9;

        const double scale = std::fmax (1.0, std::fmax (std::abs (a), std::abs (b)));
        return std::abs (a - b) <= kTolerance * scale;
    }

    // Everything but the tag.
    bool sameContent (const Sequence& a, const Sequence& b) noexcept
    {
        if (a.numSteps != b.numSteps || ! sameValue (a.stepsPerBeat, b.stepsPerBeat)
            || ! sameValue (a.gateMs, b.gateMs) || a.legato != b.legato)
            return false;

        for (int i = 0; i < a.numSteps; ++i)
        {
            const Step& x = a.steps[idx (i)];
            const Step& y = b.steps[idx (i)];

            if (x.numNotes != y.numNotes)
                return false;

            for (int j = 0; j < x.numNotes; ++j)
            {
                const StepNote& m = x.notes[idx (j)];
                const StepNote& n = y.notes[idx (j)];

                if (! sameValue (m.delay, n.delay)
                    || ! sameValue (static_cast<double> (m.probability), static_cast<double> (n.probability))
                    || m.note != n.note || m.velocity != n.velocity)
                    return false;
            }
        }
        return true;
    }

    bool chordHas (const Step& chord, uint8_t note) noexcept
    {
        for (int i = 0; i < chord.numNotes; ++i)
            if (chord.notes[idx (i)].note == note)
                return true;
        return false;
    }
}

void Sequence::copyFrom (const Sequence& other) noexcept
{
    numSteps     = other.numSteps;
    stepsPerBeat = other.stepsPerBeat;
    gateMs       = other.gateMs;
    legato       = other.legato;
    tag          = other.tag;

    for (int i = 0; i < other.numSteps; ++i)
        steps[static_cast<size_t> (i)] = other.steps[static_cast<size_t> (i)];
}

StepSequencer::StepSequencer() = default;

void StepSequencer::setSeed (uint64_t seed) noexcept
{
    rngState = seed;
}

double StepSequencer::nextDouble() noexcept
{
    rngState += 0x9E3779B97F4A7C15ULL;

    uint64_t z = rngState;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    z ^= z >> 31;

    // Top 53 bits scaled into [0, 1).
    return static_cast<double> (z >> 11) * (1.0 / 9007199254740992.0);
}

void StepSequencer::startNote (EventBuffer& out, int sampleOffset, uint8_t note, uint8_t velocity,
                               double offBeat) noexcept
{
    // An earlier instance of this pitch that is still sounding ends where the
    // new one starts, so its note-off cannot land inside the new note. One that
    // started later in this block than the new note cannot be ended yet (its
    // note-off would reach the host before its note-on).
    auto endsHere = [note, sampleOffset] (const PendingOff& off) noexcept
    {
        return off.note == note && off.startSample <= sampleOffset;
    };

    int same = 0;
    for (int i = 0; i < numPendingOffs; ++i)
        if (endsHere (pendingOffs[idx (i)]))
            ++same;

    const bool full = numPendingOffs - same >= kMaxPending;

    // Make room by ending the note that has been sounding longest, right where
    // the new one starts. A note that starts later in this block than the new
    // one cannot be ended yet (its note-off would reach the host before its
    // note-on), so the oldest of the others goes. Everything is checked up
    // front so the pool is only touched when the events fit.
    int victim = 0;

    if (full)
    {
        while (victim < numPendingOffs && pendingOffs[idx (victim)].startSample > sampleOffset)
            ++victim;

        if (victim == numPendingOffs)
            return;
    }

    if (out.count + same + (full ? 2 : 1) > kMaxEventsPerBlock)
        return;

    if (same > 0)
    {
        int kept = 0;
        for (int i = 0; i < numPendingOffs; ++i)
        {
            const PendingOff off = pendingOffs[idx (i)];

            if (endsHere (off))
                out.push (makeNoteOff (sampleOffset, note));
            else
                pendingOffs[idx (kept++)] = off;
        }
        numPendingOffs = kept;
    }

    if (full)
    {
        out.push (makeNoteOff (sampleOffset, pendingOffs[idx (victim)].note));

        for (int i = victim + 1; i < numPendingOffs; ++i)
            pendingOffs[idx (i - 1)] = pendingOffs[idx (i)];
        --numPendingOffs;
    }

    out.push (makeNoteOn (sampleOffset, note, velocity));
    pendingOffs[idx (numPendingOffs++)] = { offBeat, note, sampleOffset, true };
}

void StepSequencer::addPendingOn (double beat, double offBeat, uint8_t note, uint8_t velocity) noexcept
{
    if (numPendingOns >= kMaxPending)
        return;   // not sounding yet, so dropping it leaves nothing hanging

    pendingOns[idx (numPendingOns++)] = { beat, offBeat, note, velocity };
}

void StepSequencer::endPending (EventBuffer& out, int sampleOffset, uint8_t note) noexcept
{
    int kept = 0;
    for (int i = 0; i < numPendingOffs; ++i)
    {
        const PendingOff off = pendingOffs[idx (i)];

        // One that started later in this block cannot be ended yet, and one
        // whose note-off does not fit stays pending rather than hanging.
        if (! (off.note == note && off.startSample <= sampleOffset
               && out.push (makeNoteOff (sampleOffset, note))))
            pendingOffs[idx (kept++)] = off;
    }
    numPendingOffs = kept;
}

void StepSequencer::releaseHeld (EventBuffer& out, int sampleOffset) noexcept
{
    int stay = 0;
    for (int i = 0; i < numHeld; ++i)
    {
        const uint8_t held = heldNotes[idx (i)];

        if (! out.push (makeNoteOff (sampleOffset, held)))
            heldNotes[idx (stay++)] = held;
    }
    numHeld = stay;
}

void StepSequencer::flush (EventBuffer& out, int sampleOffset) noexcept
{
    for (int i = 0; i < numPendingOffs; ++i)
        out.push (makeNoteOff (sampleOffset, pendingOffs[idx (i)].note));
    numPendingOffs = 0;

    for (int i = 0; i < numHeld; ++i)
        out.push (makeNoteOff (sampleOffset, heldNotes[idx (i)]));
    numHeld = 0;

    numPendingOns = 0;   // not sounding yet — just drop them
    hasLastStep   = false;
    hasChordStep  = false;
}

void StepSequencer::rebasePending (double loopLength) noexcept
{
    for (int i = 0; i < numPendingOffs; ++i)
        pendingOffs[idx (i)].beat -= loopLength;

    for (int i = 0; i < numPendingOns; ++i)
    {
        pendingOns[idx (i)].beat    -= loopLength;
        pendingOns[idx (i)].offBeat -= loopLength;
    }
}

void StepSequencer::rebaseStepPosition (double beat) noexcept
{
    const double mult = current.stepsPerBeat;

    hasLastStep  = mult > 0.0;
    hasChordStep = false;   // no step of the new grid has sounded yet
    if (hasLastStep)
        lastStepIndex = toInt (std::ceil (beat * mult)) - 1;
}

// Apply an edit to the step that is sounding right now instead of waiting for
// the next boundary. Removed notes stop immediately; added notes strike
// immediately (or at their phrased moment if it is still ahead), with
// note-offs kept on the grid. Unchanged notes are left alone so an edit can't
// retrigger them or re-roll their probability dice, which also makes a resend
// of identical content silent. Only done while the step mapping is stable —
// same cycle length and rate — because a length change re-maps which chord
// "now" even is, and swapping the sounding chord mid-step on every add/delete
// would glitch more than it helps.
void StepSequencer::takeSequence (const Sequence& incoming, const BlockInfo& block, bool reconcile,
                                  EventBuffer& out) noexcept
{
    // The page resends what it already has whenever it is opened. Nothing
    // about that is an edit, so it must not touch what is sounding: the
    // reconciliation below would silence an earlier step's note that is still
    // ringing into this one.
    if (sameContent (current, incoming))
    {
        current.tag = incoming.tag;
        return;
    }

    const int    oldN    = current.numSteps;
    const double oldMult = current.stepsPerBeat;
    const bool   hadStep = reconcile && hasChordStep && oldN > 0 && ! current.legato;

    // The pre-edit chord has to be kept: the copy below overwrites it.
    Step oldChord;
    if (hadStep)
        oldChord = current.steps[idx (wrapIndex (chordStepIndex, oldN))];

    current.copyFrom (incoming);

    const int  newN     = current.numSteps;
    const bool sameMult = std::abs (current.stepsPerBeat - oldMult) < 1.0e-9;

    // The step position counts steps at the old rate. Left alone, a switch to
    // a slower rate would stay silent until the new count caught up with it.
    // Notes already sounding keep their scheduled note-offs.
    if (! sameMult)
    {
        rebaseStepPosition (block.beatPos);
        return;
    }

    if (! (hadStep && ! current.legato && newN == oldN))
        return;

    const Step& newChord = current.steps[idx (wrapIndex (chordStepIndex, newN))];

    // Removed notes: silence ringing ones now, drop phrased ones that haven't
    // fired yet.
    int kept = 0;
    for (int i = 0; i < numPendingOffs; ++i)
    {
        const PendingOff off = pendingOffs[idx (i)];

        if (chordHas (newChord, off.note) || ! out.push (makeNoteOff (0, off.note)))
            pendingOffs[idx (kept++)] = off;
    }
    numPendingOffs = kept;

    kept = 0;
    for (int i = 0; i < numPendingOns; ++i)
    {
        const PendingOn on = pendingOns[idx (i)];

        if (chordHas (newChord, on.note))
            pendingOns[idx (kept++)] = on;
    }
    numPendingOns = kept;

    // Added notes: strike them into the remainder of the step.
    const double stepLen      = 1.0 / current.stepsPerBeat;
    const double gateBeats    = limit (0.01, stepLen,
        current.gateMs * 0.001 * (block.bpm / 60.0));

    for (int i = 0; i < newChord.numNotes; ++i)
    {
        const StepNote& sn = newChord.notes[idx (i)];
        const double    p  = static_cast<double> (sn.probability);

        if (chordHas (oldChord, sn.note))
            continue;   // untouched by this edit
        if (p < 1.0 && nextDouble() >= p)
            continue;

        const double triggerBeat = triggerBeatOf (chordStepIndex, sn.delay, stepLen);
        const double offBeat     = offBeatOf (chordStepIndex, sn.delay, stepLen, triggerBeat, gateBeats);

        if (offBeat <= block.beatPos)
            continue;   // its window in this step already passed

        if (triggerBeat > block.beatPos)
            addPendingOn (triggerBeat, offBeat, sn.note, sn.velocity);   // fires on time
        else
            startNote (out, 0, sn.note, sn.velocity, offBeat);
    }
}

// One step boundary: strike (or, with legato, re-voice) the step's chord and
// report it. The sequence may be empty, in which case only the report is made.
void StepSequencer::fireStep (int step, double stepSize, double gateBeats, int sampleOffset,
                              EventBuffer& out, StepEventBuffer& steps) noexcept
{
    StepEvent event;
    event.index        = step;
    event.stepsPerBeat = current.stepsPerBeat;
    event.tag          = current.tag;

    if (current.numSteps > 0)
    {
        const Step& chord = current.steps[idx (wrapIndex (step, current.numSteps))];

        if (current.legato)
        {
            // Diff transition: release held notes leaving the chord...
            int stay = 0;
            for (int i = 0; i < numHeld; ++i)
            {
                const uint8_t held = heldNotes[idx (i)];

                if (chordHas (chord, held) || ! out.push (makeNoteOff (sampleOffset, held)))
                    heldNotes[idx (stay++)] = held;
            }
            numHeld = stay;

            // ...start notes entering it; notes in both keep ringing.
            for (int i = 0; i < chord.numNotes; ++i)
            {
                const StepNote& sn = chord.notes[idx (i)];

                bool isHeld = false;
                for (int h = 0; h < numHeld; ++h)
                    if (heldNotes[idx (h)] == sn.note)
                        isHeld = true;

                if (! isHeld && numHeld < kMaxNotesPerStep)
                {
                    // A gated note from before legato was switched on may
                    // still hold this pitch; its note-off would otherwise
                    // land inside the note the chord is about to hold.
                    endPending (out, sampleOffset, sn.note);

                    if (out.push (makeNoteOn (sampleOffset, sn.note, sn.velocity)))
                        heldNotes[idx (numHeld++)] = sn.note;
                }

                event.played[idx (event.numPlayed++)] = sn.note;
            }
        }
        else
        {
            for (int i = 0; i < chord.numNotes; ++i)
            {
                const StepNote& sn = chord.notes[idx (i)];
                const double    p  = static_cast<double> (sn.probability);

                // Roll the dice once per hit — probability below 1.0 makes
                // the note trigger only sometimes.
                if (p < 1.0 && nextDouble() >= p)
                    continue;

                event.played[idx (event.numPlayed++)] = sn.note;

                const double triggerBeat = triggerBeatOf (step, sn.delay, stepSize);
                const double offBeat     = offBeatOf (step, sn.delay, stepSize, triggerBeat, gateBeats);

                if (sn.delay <= 0.0)
                    startNote (out, sampleOffset, sn.note, sn.velocity, offBeat);
                else
                    // Phrased — trigger later within the step.
                    addPendingOn (triggerBeat, offBeat, sn.note, sn.velocity);
            }
        }
    }

    steps.push (event);

    lastStepIndex = step;
    hasLastStep   = true;

    if (current.numSteps > 0)
    {
        chordStepIndex = step;
        hasChordStep   = true;
    }
}

void StepSequencer::catchUp (const BlockInfo& block, double beatsPerSample, EventBuffer& out,
                             StepEventBuffer& steps) noexcept
{
    const double mult = current.stepsPerBeat;

    if (! (mult > 0.0))
        return;

    const double stepSize = 1.0 / mult;
    const double scaled   = block.beatPos * mult;
    const double floored  = std::floor (scaled);

    if (std::ceil (scaled) == floored)
        return;   // landed on a boundary: the normal pass fires it

    const int    step       = toInt (floored);
    const double pastBeats  = block.beatPos - static_cast<double> (step) * stepSize;

    if (! (pastBeats < beatsPerSample * block.numSamples))
        return;   // inside the step, but the boundary is further back than a block

    const double gateBeats = limit (0.01, stepSize, current.gateMs * 0.001 * (block.bpm / 60.0));
    fireStep (step, stepSize, gateBeats, 0, out, steps);
}

void StepSequencer::runSegment (const Segment& segment, const BlockInfo& block, EventBuffer& out,
                                StepEventBuffer& steps) noexcept
{
    const double endBeat = segment.beatEnd;

    // Sample at which `beat` falls, clamped into the segment.
    auto sampleFor = [&segment] (double beat) noexcept
    {
        const double v  = segment.sampleStart + (beat - segment.beatStart) / segment.beatsPerSample;
        const double lo = static_cast<double> (segment.lowestSample);
        const double hi = static_cast<double> (segment.highestSample);

        if (! (v > lo))
            return segment.lowestSample;
        if (v >= hi)
            return segment.highestSample;
        return static_cast<int> (v);
    };

    // The note-offs that were pending when the segment began and are due by
    // `beat`. A note struck inside the segment keeps its note-off for the next
    // pass.
    for (int i = 0; i < numPendingOffs; ++i)
        pendingOffs[idx (i)].struck = false;

    auto releaseDueBy = [&] (double beat) noexcept
    {
        int kept = 0;
        for (int i = 0; i < numPendingOffs; ++i)
        {
            const PendingOff off = pendingOffs[idx (i)];

            if (! (! off.struck && off.beat <= beat && out.push (makeNoteOff (sampleFor (off.beat), off.note))))
                pendingOffs[idx (kept++)] = off;
        }
        numPendingOffs = kept;
    };

    const double mult = current.stepsPerBeat;

    double stepSize  = 0.0;
    double gateBeats = 0.0;
    int    nextStep  = 0;
    int    lastStep  = -1;

    if (mult > 0.0)
    {
        stepSize = 1.0 / mult;

        // Gate length from the UI-supplied duration, capped at one full step so
        // a note always ends before the same pitch can retrigger.
        gateBeats = limit (0.01, stepSize, current.gateMs * 0.001 * (block.bpm / 60.0));

        // The step after the last one processed, so a boundary the previous
        // block's end missed by rounding is late rather than lost.
        nextStep = hasLastStep ? lastStepIndex + 1
                               : toInt (std::ceil (segment.beatStart * mult));
        lastStep = toInt (std::floor (endBeat * mult));

        if (static_cast<long long> (lastStep) - nextStep >= kMaxStepsPerSegment)
            nextStep = lastStep - static_cast<int> (kMaxStepsPerSegment) + 1;
    }
    else
    {
        hasLastStep  = false;
        hasChordStep = false;
    }

    // Boundaries and phrased note-ons in the order they happen. A boundary goes
    // first where the two coincide; a small delay triggers in the block it was
    // scheduled in. Every note-off due by a strike is sent ahead of it, so an
    // off and an on of one pitch at one sample stay off-then-on.
    for (;;)
    {
        bool   haveBoundary = false;
        double boundaryBeat = 0.0;

        if (nextStep <= lastStep)
        {
            boundaryBeat = triggerBeatOf (nextStep, 0.0, stepSize);
            haveBoundary = boundaryBeat < endBeat - segment.endMargin;
        }

        int phrased = -1;
        for (int i = 0; i < numPendingOns; ++i)
            if (pendingOns[idx (i)].beat < endBeat
                && (phrased < 0 || pendingOns[idx (i)].beat < pendingOns[idx (phrased)].beat))
                phrased = i;

        if (haveBoundary && (phrased < 0 || boundaryBeat <= pendingOns[idx (phrased)].beat))
        {
            releaseDueBy (boundaryBeat);
            fireStep (nextStep++, stepSize, gateBeats, sampleFor (boundaryBeat), out, steps);
        }
        else if (phrased >= 0)
        {
            const PendingOn on = pendingOns[idx (phrased)];

            for (int i = phrased + 1; i < numPendingOns; ++i)
                pendingOns[idx (i - 1)] = pendingOns[idx (i)];
            --numPendingOns;

            releaseDueBy (on.beat);
            startNote (out, sampleFor (on.beat), on.note, on.velocity, on.offBeat);
        }
        else
        {
            break;
        }
    }

    releaseDueBy (endBeat);
}

void StepSequencer::process (const BlockInfo& block, const Sequence* newSequence,
                             EventBuffer& out, StepEventBuffer& steps) noexcept
{
    const int numSamples = block.numSamples;

    if (! block.playing)
    {
        // Nothing is in flight while stopped, so a new sequence is simply the
        // current one; the first playing block starts from a clean slate.
        if (newSequence != nullptr)
            current.copyFrom (*newSequence);

        // Transport stopped — reset step tracking and flush anything sounding
        if (wasPlaying)
            flush (out, 0);
        hasLastStep  = false;
        hasChordStep = false;
        wrapPending  = false;

        wasPlaying = false;
        return;
    }

    if (numSamples <= 0 || ! (block.sampleRate > 0.0))
    {
        // A new rate has to move the step position even though no time passes.
        if (newSequence != nullptr)
        {
            if (wasPlaying)
                takeSequence (*newSequence, block, false, out);
            else
                current.copyFrom (*newSequence);
        }
        return;
    }

    const double beatPos        = block.beatPos;
    const double beatsPerSample = (block.bpm / 60.0) / block.sampleRate;

    // Where did the host put this block relative to the end of the last one?
    // The first block after a stop is a start, not a jump.
    bool jumped  = false;
    bool wrapped = false;

    if (wasPlaying)
    {
        if (std::abs (beatPos - expectedBeat) <= kJumpTolerance)
            ;   // played on
        else if (wrapPending && std::abs (beatPos - wrapTarget) <= kJumpTolerance)
            wrapped = true;
        else
            jumped = true;
    }
    wrapPending = false;

    if (jumped)
        flush (out, 0);
    else if (wrapped)
        rebasePending (wrapLength);

    // After a wrap the sounding step belongs to the end of the loop, which is
    // the wrong place to apply an edit, so it only replaces the sequence.
    if (newSequence != nullptr)
        takeSequence (*newSequence, block, ! wrapped, out);

    if (wrapped)
        rebaseStepPosition (wrapTarget);

    // If legato notes are ringing but the sequence can no longer sustain them
    // (cleared, or replaced by a non-legato one), release them now.
    if ((current.numSteps == 0 || ! current.legato) && numHeld > 0)
        releaseHeld (out, 0);

    // Phrased notes scheduled from a sequence that no longer exists
    if (current.numSteps == 0)
        numPendingOns = 0;

    if (jumped)
        catchUp (block, beatsPerSample, out, steps);

    // The block is one linear stretch of the timeline unless it crosses the end
    // of a host loop that the host does not split at.
    const bool   loopActive = block.looping && block.loopEnd > block.loopStart && beatsPerSample > 0.0;
    const double halfSample = 0.5 * beatsPerSample;
    const double loopLength = block.loopEnd - block.loopStart;

    Segment segment;
    segment.beatStart      = beatPos;
    segment.sampleStart    = 0.0;
    segment.beatsPerSample = beatsPerSample;
    segment.highestSample  = numSamples - 1;

    double endBeat = beatPos;

    for (int wraps = 0;; ++wraps)
    {
        endBeat = segment.beatStart + (numSamples - segment.sampleStart) * beatsPerSample;

        const bool inLoop = loopActive && segment.beatStart > block.loopStart - halfSample
                                       && segment.beatStart < block.loopEnd;

        if (inLoop && wraps < kMaxWrapsPerBlock && endBeat - block.loopEnd > halfSample)
        {
            // The host plays straight through the loop end: finish the loop,
            // then carry on from its start.
            const double wrapSample = segment.sampleStart
                                    + (block.loopEnd - segment.beatStart) / beatsPerSample;

            const int endSample = toInt (std::ceil (wrapSample)) - 1;

            // The boundary at the loop end belongs to the next pass, but the
            // host's loop end and the sequencer's boundary there can be an ulp
            // apart (a triplet position), the boundary being the smaller.
            segment.beatEnd       = block.loopEnd;
            segment.endMargin     = halfSample;
            segment.highestSample = endSample < segment.lowestSample ? segment.lowestSample
                                  : (endSample > numSamples - 1 ? numSamples - 1 : endSample);
            runSegment (segment, block, out, steps);
            segment.endMargin = 0.0;

            rebasePending (loopLength);
            rebaseStepPosition (block.loopStart);

            segment.beatStart     = block.loopStart;
            segment.sampleStart   = wrapSample;
            segment.lowestSample  = toInt (limit (0.0, static_cast<double> (numSamples - 1),
                                                  std::floor (wrapSample)));
            segment.highestSample = numSamples - 1;
            continue;
        }

        segment.beatEnd = endBeat;

        // A block that stops at the loop end (to within half a sample) is one
        // the host split itself: the boundary at the loop end belongs to the
        // next block's start. Remember that so the next block is a wrap.
        if (inLoop && endBeat >= block.loopEnd - kJumpTolerance && endBeat <= block.loopEnd + halfSample)
        {
            segment.beatEnd = endBeat < block.loopEnd ? endBeat : block.loopEnd;
            if (endBeat >= block.loopEnd - halfSample)
                segment.endMargin = halfSample;
            wrapPending     = true;
            wrapTarget      = block.loopStart;
            wrapLength      = loopLength;
        }

        runSegment (segment, block, out, steps);
        break;
    }

    for (int i = 0; i < numPendingOffs; ++i)
        pendingOffs[idx (i)].startSample = -1;

    expectedBeat = endBeat;
    wasPlaying   = true;
}

const Sequence& StepSequencer::sequence() const noexcept { return current; }

} // namespace seq
