#pragma once

#include "NoteScheduler.h"
#include "StepSequencer.h"
#include <juce_core/juce_core.h>
#include <map>

// =============================================================================
// Bridge — the one place that knows the JSON shapes crossing between the web
// view and C++, and the shape of the saved plugin state.
//
// The canonical examples live in tests/fixtures/bridge/contract.json; the
// parsers here and the dev harness (web/dev/mock-juce.js) are both checked
// against that file. MESSAGE thread only.
// =============================================================================
namespace bridge
{

// ---- JS → C++ ---------------------------------------------------------------

// `setStepSequence` payload → Sequence.
// Lenient on input: a step may be a bare note or an array, a note may be a
// bare int or { n, d, p, v } with any of d/p/v missing (defaults 0 / 1 / 100).
// Returns false, leaving dest untouched, if the payload is malformed or
// exceeds seq::kMaxSteps / seq::kMaxNotesPerStep (never truncates).
bool parseStepSequence (const juce::var& payload, seq::Sequence& dest);

// `midi` payload → ImmediateEvent. False if the type is unknown.
bool parseMidi (const juce::var& payload, seq::ImmediateEvent& dest);

// ---- Saved plugin state -----------------------------------------------------

struct PluginState
{
    std::map<juce::String, juce::String> web;   // experiment id → JSON string
    juce::var sequence;                         // last setStepSequence payload, void if none
};

// v2: { "v": 2, "web": { ... }, "sequence": { ... } | null }
juce::String serialiseState (const PluginState& state);

// Accepts v2, and v1 (a flat object of key → JSON string, no sequence).
bool parseState (const juce::String& json, PluginState& dest);

// ---- C++ → JS ---------------------------------------------------------------

struct Tick
{
    double bpm                = 120.0;
    double beatPosition       = 0.0;
    bool   isPlaying          = false;
    int    timeSigNumerator   = 4;
    int    timeSigDenominator = 4;
};

// `tick` payload: transport plus the step boundaries crossed since the last one.
juce::var makeTick (const Tick& tick, const seq::StepEvent* steps, int numSteps);

// `state` payload: { web: { key: jsonString } }
juce::var makeState (const std::map<juce::String, juce::String>& web);

} // namespace bridge
