#include "Bridge.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace bridge
{

namespace
{
    bool isNumber (const juce::var& v)
    {
        return v.isInt() || v.isInt64() || v.isDouble() || v.isBool();
    }

    // juce::var::isObject() is also true for arrays.
    bool isDictionary (const juce::var& v)
    {
        return v.getDynamicObject() != nullptr;
    }

    // Reads a numeric property. A missing (or null) key leaves `result` alone and
    // is fine; a key of any other type, or a non-finite number, is malformed.
    bool readNumber (const juce::var& object, const char* key, double& result)
    {
        const auto v = object.getProperty (key, juce::var());

        if (v.isVoid())
            return true;

        if (! isNumber (v))
            return false;

        const double d = static_cast<double> (v);
        if (! std::isfinite (d))
            return false;

        result = d;
        return true;
    }

    int roundedClamp (double v, int lo, int hi)
    {
        return static_cast<int> (std::clamp (std::round (v), static_cast<double> (lo), static_cast<double> (hi)));
    }

    bool parseNote (const juce::var& v, seq::StepNote& note)
    {
        if (isNumber (v))
        {
            const double n = static_cast<double> (v);
            if (! std::isfinite (n))
                return false;

            note = {};
            note.note = static_cast<uint8_t> (roundedClamp (n, 0, 127));
            return true;
        }

        if (! isDictionary (v))
            return false;

        // A note without a pitch has nothing to play.
        double n = 0.0, d = 0.0, p = 1.0, vel = 100.0;
        if (! v.hasProperty ("n") || ! isNumber (v["n"]))
            return false;

        if (! readNumber (v, "n", n) || ! readNumber (v, "d", d)
            || ! readNumber (v, "p", p) || ! readNumber (v, "v", vel))
            return false;

        note = {};
        note.note        = static_cast<uint8_t> (roundedClamp (n, 0, 127));
        note.delay       = std::clamp (d, 0.0, 0.99);
        note.probability = static_cast<float> (std::clamp (p, 0.0, 1.0));
        note.velocity    = static_cast<uint8_t> (roundedClamp (vel, 1, 127));
        return true;
    }
}

bool parseStepSequence (const juce::var& payload, seq::Sequence& dest)
{
    if (! isDictionary (payload))
        return false;

    // `notes` is what older pages called the steps.
    const auto stepsVar = payload.hasProperty ("steps") ? payload["steps"] : payload["notes"];
    const auto* steps   = stepsVar.getArray();

    if (steps == nullptr || steps->size() > seq::kMaxSteps)
        return false;

    // Everything is checked before dest is touched, and a Sequence is too large
    // to build on the stack, so the notes are collected on the heap first.
    std::vector<seq::StepNote> notes;
    std::vector<int>           counts;
    counts.reserve (static_cast<size_t> (steps->size()));

    for (const auto& step : *steps)
    {
        int count = 0;

        if (const auto* chord = step.getArray())
        {
            if (chord->size() > seq::kMaxNotesPerStep)
                return false;

            for (const auto& n : *chord)
            {
                seq::StepNote note;
                if (! parseNote (n, note))
                    return false;
                notes.push_back (note);
                ++count;
            }
        }
        else
        {
            seq::StepNote note;
            if (! parseNote (step, note))
                return false;
            notes.push_back (note);
            count = 1;
        }

        counts.push_back (count);
    }

    double stepsPerBeat = 2.0, durationMs = 150.0, tag = 0.0;
    bool   legato = false;

    const char* rateKey = payload.hasProperty ("stepsPerBeat") ? "stepsPerBeat" : "subdivision";

    if (! readNumber (payload, rateKey, stepsPerBeat)
        || ! readNumber (payload, "durationMs", durationMs)
        || ! readNumber (payload, "tag", tag))
        return false;

    const auto legatoVar = payload.getProperty ("legato", juce::var());
    if (! legatoVar.isVoid())
    {
        if (! isNumber (legatoVar))
            return false;
        legato = static_cast<bool> (legatoVar);
    }

    if (! (stepsPerBeat > 0.0))
        stepsPerBeat = 2.0;
    if (! (durationMs > 0.0))
        durationMs = 150.0;

    dest.numSteps     = static_cast<int> (steps->size());
    dest.stepsPerBeat = stepsPerBeat;
    dest.gateMs       = durationMs;
    dest.legato       = legato;
    dest.tag          = roundedClamp (tag, -2147483647, 2147483647);

    size_t next = 0;
    for (size_t i = 0; i < counts.size(); ++i)
    {
        auto& step = dest.steps[i];
        step.numNotes = counts[i];

        for (int j = 0; j < counts[i]; ++j)
            step.notes[static_cast<size_t> (j)] = notes[next++];
    }

    return true;
}

bool parseMidi (const juce::var& payload, seq::ImmediateEvent& dest)
{
    if (! isDictionary (payload))
        return false;

    const auto type = payload["type"].toString();
    seq::ImmediateEvent event;

    if (type == "noteOn")            event.type = seq::ImmediateEvent::NoteOn;
    else if (type == "noteOff")      event.type = seq::ImmediateEvent::NoteOff;
    else if (type == "note")         event.type = seq::ImmediateEvent::Note;
    else if (type == "allNotesOff")  event.type = seq::ImmediateEvent::AllNotesOff;
    else                             return false;

    double note = 0.0, velocity = 100.0, channel = 1.0, durationMs = 0.0;

    if (! readNumber (payload, "note", note) || ! readNumber (payload, "velocity", velocity)
        || ! readNumber (payload, "channel", channel) || ! readNumber (payload, "durationMs", durationMs))
        return false;

    if (event.type != seq::ImmediateEvent::AllNotesOff && ! isNumber (payload["note"]))
        return false;

    event.note       = static_cast<uint8_t> (roundedClamp (note, 0, 127));
    event.velocity   = static_cast<uint8_t> (roundedClamp (velocity, 1, 127));
    event.channel    = static_cast<uint8_t> (roundedClamp (channel, 1, 16));
    event.durationMs = event.type == seq::ImmediateEvent::Note
                         ? static_cast<float> (std::clamp (durationMs, 0.0, 3600000.0))
                         : 0.0f;

    dest = event;
    return true;
}

juce::String serialiseState (const PluginState& state)
{
    auto* web = new juce::DynamicObject();
    for (const auto& [key, json] : state.web)
        web->setProperty (key, json);

    auto* root = new juce::DynamicObject();
    root->setProperty ("v", 2);
    root->setProperty ("web", juce::var (web));
    root->setProperty ("sequence", isDictionary (state.sequence) ? state.sequence : juce::var());

    return juce::JSON::toString (juce::var (root), true);
}

bool parseState (const juce::String& json, PluginState& dest)
{
    juce::var parsed;
    if (juce::JSON::parse (json, parsed).failed())
        return false;

    const auto* object = parsed.getDynamicObject();
    if (object == nullptr)
        return false;

    PluginState result;

    const auto version = object->getProperty ("v");

    if (isNumber (version))
    {
        // v2 is recognised by the integer 2 and an object under `web`; any other
        // number there is a format this build does not know.
        const auto web = object->getProperty ("web");

        if (! (version.isInt() || version.isInt64()) || static_cast<int> (version) != 2
            || ! isDictionary (web))
            return false;

        for (const auto& property : web.getDynamicObject()->getProperties())
            if (property.value.isString())
                result.web[property.name.toString()] = property.value.toString();

        const auto sequence = object->getProperty ("sequence");
        if (isDictionary (sequence))
            result.sequence = sequence;
    }
    else
    {
        for (const auto& property : object->getProperties())
            if (property.value.isString())
                result.web[property.name.toString()] = property.value.toString();
    }

    dest = std::move (result);
    return true;
}

juce::var makeTick (const Tick& tick, const seq::StepEvent* steps, int numSteps)
{
    // A non-finite number would be written as something JSON cannot parse.
    auto finite = [] (double v, double fallback) { return std::isfinite (v) ? v : fallback; };

    juce::Array<juce::var> stepList;

    if (steps != nullptr)
    {
        for (int i = 0; i < numSteps; ++i)
        {
            const auto& step = steps[i];

            juce::Array<juce::var> played;
            for (int n = 0; n < std::clamp (step.numPlayed, 0, seq::kMaxNotesPerStep); ++n)
                played.add (static_cast<int> (step.played[static_cast<size_t> (n)]));

            auto* entry = new juce::DynamicObject();
            entry->setProperty ("i", step.index);
            entry->setProperty ("spb", finite (step.stepsPerBeat, 2.0));
            entry->setProperty ("tag", step.tag);
            entry->setProperty ("played", played);
            stepList.add (juce::var (entry));
        }
    }

    auto* obj = new juce::DynamicObject();
    obj->setProperty ("bpm",                finite (tick.bpm, 120.0));
    obj->setProperty ("beatPosition",       finite (tick.beatPosition, 0.0));
    obj->setProperty ("isPlaying",          tick.isPlaying);
    obj->setProperty ("timeSigNumerator",   tick.timeSigNumerator);
    obj->setProperty ("timeSigDenominator", tick.timeSigDenominator);
    obj->setProperty ("steps",              stepList);
    return juce::var (obj);
}

juce::var makeState (const std::map<juce::String, juce::String>& web)
{
    auto* webObject = new juce::DynamicObject();
    for (const auto& [key, json] : web)
        webObject->setProperty (key, json);

    auto* obj = new juce::DynamicObject();
    obj->setProperty ("web", juce::var (webObject));
    return juce::var (obj);
}

} // namespace bridge
