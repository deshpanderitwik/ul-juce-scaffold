#include "../check.h"
#include "Bridge.h"

#include <cmath>
#include <memory>

// Every example in tests/fixtures/bridge/contract.json goes through the real
// parsers and builders, plus the rejection and clamping cases that only make
// sense in code.
namespace
{
    juce::var loadContract()
    {
        const auto file = juce::File (SCAFFOLD_FIXTURES_DIR).getChildFile ("bridge/contract.json");
        return juce::JSON::parse (file);
    }

    // The checks compare parsed values with the literals the fixtures spell out;
    // the parser stores them without arithmetic, but exact float equality is
    // not something to write in a test.
    bool isAbout (double a, double b)
    {
        return std::abs (a - b) < 1.0e-6;
    }

    // The fixtures are normative, so a missing section must fail loudly.
    // Returned by value: the arrays inside a temporary var would not outlive it.
    juce::Array<juce::var> examplesOf (const juce::var& section)
    {
        if (const auto* examples = section["examples"].getArray())
            return *examples;
        return {};
    }

    std::unique_ptr<seq::Sequence> makeSequence()
    {
        return std::make_unique<seq::Sequence>();
    }

    // Whether two parsed JSON trees say the same thing. Numbers compare as
    // numbers (120 and 120.0 are the same), and objects as key sets.
    bool sameJson (const juce::var& a, const juce::var& b)
    {
        auto isNumber = [] (const juce::var& v) { return v.isInt() || v.isInt64() || v.isDouble(); };

        if (a.isBool() || b.isBool())
            return a.isBool() && b.isBool() && static_cast<bool> (a) == static_cast<bool> (b);

        if (isNumber (a) || isNumber (b))
            return isNumber (a) && isNumber (b) && std::abs (static_cast<double> (a) - static_cast<double> (b)) < 1.0e-9;

        if (a.isString() || b.isString())
            return a.isString() && b.isString() && a.toString() == b.toString();

        if (a.isArray() || b.isArray())
        {
            if (! (a.isArray() && b.isArray()) || a.size() != b.size())
                return false;

            for (int i = 0; i < a.size(); ++i)
                if (! sameJson (a[i], b[i]))
                    return false;
            return true;
        }

        if (a.isObject() || b.isObject())
        {
            if (! (a.isObject() && b.isObject()))
                return false;

            const auto& pa = a.getDynamicObject()->getProperties();
            const auto& pb = b.getDynamicObject()->getProperties();

            if (pa.size() != pb.size())
                return false;

            for (const auto& p : pa)
                if (! pb.contains (p.name) || ! sameJson (p.value, pb[p.name]))
                    return false;
            return true;
        }

        return a.isVoid() && b.isVoid();
    }

    // What goes over the wire and arrives in the page.
    juce::var throughJson (const juce::var& v)
    {
        return juce::JSON::parse (juce::JSON::toString (v, true));
    }

    juce::var seqPayload (const juce::String& json)
    {
        return juce::JSON::parse (json);
    }

    void checkExpectedSequence (const juce::String& name, const juce::var& example)
    {
        auto sequence = makeSequence();
        const bool ok = bridge::parseStepSequence (example["payload"], *sequence);
        if (! ok)
            check::fail (__FILE__, __LINE__, "parseStepSequence rejected " + name.toStdString());
        if (! ok)
            return;

        const auto expect = example["expect"];
        CHECK_EQ (sequence->numSteps, static_cast<int> (expect["numSteps"]));

        const auto* counts = expect["notesPerStep"].getArray();
        if (counts == nullptr)
        {
            check::fail (__FILE__, __LINE__, "no notesPerStep for " + name.toStdString());
            return;
        }

        CHECK_EQ (sequence->numSteps, counts->size());
        for (int i = 0; i < counts->size() && i < sequence->numSteps; ++i)
            CHECK_EQ (sequence->steps[static_cast<size_t> (i)].numNotes, static_cast<int> ((*counts)[i]));
    }
}

TEST (bridge_fixture_file_loads)
{
    const auto contract = loadContract();
    REQUIRE (contract.isObject());
    CHECK (contract["jsToCpp"].isObject());
    CHECK (contract["cppToJs"].isObject());
    CHECK (contract["persisted"].isObject());
}

// ---- setStepSequence ------------------------------------------------------------

TEST (bridge_step_sequence_canonical_examples)
{
    const auto examples = examplesOf (loadContract()["jsToCpp"]["setStepSequence"]);
    REQUIRE (examples.size() > 0);
    CHECK_EQ (examples.size(), 3);

    for (const auto& example : examples)
        checkExpectedSequence (example["name"].toString(), example);
}

TEST (bridge_step_sequence_lenient_examples)
{
    const auto examples = examplesOf (loadContract()["jsToCpp"]["setStepSequence"]["lenientExamples"]);
    REQUIRE (examples.size() > 0);
    CHECK_EQ (examples.size(), 2);

    for (const auto& example : examples)
        checkExpectedSequence (example["name"].toString(), example);
}

TEST (bridge_step_sequence_canonical_values)
{
    const auto contract = loadContract();
    const auto examples = examplesOf (contract["jsToCpp"]["setStepSequence"]);

    auto sequence = makeSequence();
    REQUIRE (bridge::parseStepSequence (examples[0]["payload"], *sequence));

    CHECK (isAbout (sequence->stepsPerBeat, 2.0));
    CHECK (isAbout (sequence->gateMs, 150.0));
    CHECK (! sequence->legato);
    CHECK_EQ (sequence->tag, 1001);
    CHECK_EQ (static_cast<int> (sequence->steps[0].notes[0].note), 60);
    CHECK_EQ (static_cast<int> (sequence->steps[1].notes[0].note), 62);
    CHECK_EQ (static_cast<int> (sequence->steps[3].notes[0].note), 67);
    CHECK_EQ (static_cast<int> (sequence->steps[3].notes[0].velocity), 80);
    CHECK (isAbout (sequence->steps[3].notes[0].probability, 0.5));
    CHECK (isAbout (sequence->steps[0].notes[0].delay, 0.0));

    REQUIRE (bridge::parseStepSequence (examples[1]["payload"], *sequence));
    CHECK (isAbout (sequence->stepsPerBeat, 0.25));
    CHECK (isAbout (sequence->gateMs, 60000.0));
    CHECK_EQ (sequence->tag, 1002);
    CHECK_EQ (static_cast<int> (sequence->steps[0].notes[1].note), 55);
    CHECK (isAbout (sequence->steps[0].notes[1].delay, 0.25));
    CHECK (isAbout (sequence->steps[0].notes[2].delay, 0.5));
    CHECK_EQ (static_cast<int> (sequence->steps[0].notes[2].velocity), 110);

    REQUIRE (bridge::parseStepSequence (examples[2]["payload"], *sequence));
    CHECK_EQ (sequence->numSteps, 0);
    CHECK (isAbout (sequence->stepsPerBeat, 4.0));   // the rate and tag still apply to a cleared sequence
    CHECK_EQ (sequence->tag, 1003);
}

TEST (bridge_step_sequence_lenient_values)
{
    const auto contract = loadContract();
    const auto examples = examplesOf (contract["jsToCpp"]["setStepSequence"]["lenientExamples"]);

    auto sequence = makeSequence();
    REQUIRE (bridge::parseStepSequence (examples[0]["payload"], *sequence));

    // Bare ints: defaults 0 / 1 / 100; `subdivision` is the rate; no tag is 0.
    CHECK (isAbout (sequence->stepsPerBeat, 2.0));
    CHECK_EQ (sequence->tag, 0);
    CHECK_EQ (static_cast<int> (sequence->steps[2].notes[0].note), 64);
    CHECK (isAbout (sequence->steps[2].notes[0].delay, 0.0));
    CHECK (isAbout (sequence->steps[2].notes[0].probability, 1.0));
    CHECK_EQ (static_cast<int> (sequence->steps[2].notes[0].velocity), 100);

    REQUIRE (bridge::parseStepSequence (examples[1]["payload"], *sequence));
    CHECK (isAbout (sequence->stepsPerBeat, 1.0));
    CHECK_EQ (static_cast<int> (sequence->steps[0].notes[0].note), 60);
    CHECK_EQ (static_cast<int> (sequence->steps[0].notes[1].note), 64);
    CHECK (isAbout (sequence->steps[0].notes[1].delay, 0.3));
    CHECK (isAbout (sequence->steps[0].notes[1].probability, 1.0));
    CHECK_EQ (static_cast<int> (sequence->steps[1].notes[0].note), 67);
    CHECK (isAbout (sequence->steps[1].notes[0].probability, 0.25));
    CHECK (isAbout (sequence->steps[1].notes[0].delay, 0.0));
    CHECK_EQ (sequence->steps[2].numNotes, 0);
}

TEST (bridge_step_sequence_clamps_values)
{
    auto sequence = makeSequence();
    REQUIRE (bridge::parseStepSequence (seqPayload (R"({"steps":[[
        {"n":300,"d":5,"p":2,"v":500},
        {"n":-5,"d":-1,"p":-1,"v":0},
        {"n":60.6,"d":0.5,"p":0.5,"v":99.4}
    ]],"stepsPerBeat":2,"durationMs":150,"legato":true,"tag":7})"), *sequence));

    const auto& notes = sequence->steps[0].notes;
    CHECK_EQ (static_cast<int> (notes[0].note), 127);
    CHECK (isAbout (notes[0].delay, 0.99));
    CHECK (isAbout (notes[0].probability, 1.0));
    CHECK_EQ (static_cast<int> (notes[0].velocity), 127);

    CHECK_EQ (static_cast<int> (notes[1].note), 0);
    CHECK (isAbout (notes[1].delay, 0.0));
    CHECK (isAbout (notes[1].probability, 0.0));
    CHECK_EQ (static_cast<int> (notes[1].velocity), 1);

    CHECK_EQ (static_cast<int> (notes[2].note), 61);
    CHECK_EQ (static_cast<int> (notes[2].velocity), 99);
    CHECK (sequence->legato);
}

TEST (bridge_step_sequence_non_positive_rate_and_gate_fall_back_to_defaults)
{
    auto sequence = makeSequence();
    REQUIRE (bridge::parseStepSequence (seqPayload (R"({"steps":[[60]],"stepsPerBeat":0,"durationMs":-3})"), *sequence));
    CHECK (isAbout (sequence->stepsPerBeat, 2.0));
    CHECK (isAbout (sequence->gateMs, 150.0));

    REQUIRE (bridge::parseStepSequence (seqPayload (R"({"steps":[[60]]})"), *sequence));
    CHECK (isAbout (sequence->stepsPerBeat, 2.0));
    CHECK (isAbout (sequence->gateMs, 150.0));
    CHECK (! sequence->legato);
    CHECK_EQ (sequence->tag, 0);
}

TEST (bridge_step_sequence_accepts_the_largest_allowed_sequence)
{
    juce::Array<juce::var> steps;
    for (int s = 0; s < seq::kMaxSteps; ++s)
    {
        juce::Array<juce::var> chord;
        for (int n = 0; n < seq::kMaxNotesPerStep; ++n)
            chord.add (30 + n);
        steps.add (juce::var (chord));
    }

    auto* payload = new juce::DynamicObject();
    payload->setProperty ("steps", steps);
    payload->setProperty ("stepsPerBeat", 4);

    auto sequence = makeSequence();
    REQUIRE (bridge::parseStepSequence (juce::var (payload), *sequence));
    CHECK_EQ (sequence->numSteps, seq::kMaxSteps);
    CHECK_EQ (sequence->steps[seq::kMaxSteps - 1].numNotes, seq::kMaxNotesPerStep);
    CHECK_EQ (static_cast<int> (sequence->steps[seq::kMaxSteps - 1].notes[seq::kMaxNotesPerStep - 1].note), 30 + seq::kMaxNotesPerStep - 1);
}

namespace
{
    // A sequence that parsing must leave exactly as it is on a rejection.
    std::unique_ptr<seq::Sequence> makeMarkedSequence()
    {
        auto sequence = makeSequence();
        bridge::parseStepSequence (seqPayload (R"({"steps":[[61],[62,63]],"stepsPerBeat":3,"durationMs":99,"legato":true,"tag":42})"),
                                   *sequence);
        return sequence;
    }

    void checkUntouched (const seq::Sequence& s, int line)
    {
        const bool same = s.numSteps == 2 && s.stepsPerBeat == 3.0 && s.gateMs == 99.0 && s.legato
                          && s.tag == 42 && s.steps[0].numNotes == 1 && s.steps[0].notes[0].note == 61
                          && s.steps[1].numNotes == 2 && s.steps[1].notes[1].note == 63;
        if (! same)
            check::fail (__FILE__, line, "destination sequence was modified by a rejected payload");
    }

    void checkRejected (const juce::var& payload, int line)
    {
        auto sequence = makeMarkedSequence();
        if (bridge::parseStepSequence (payload, *sequence))
            check::fail (__FILE__, line, "payload was accepted: " + juce::JSON::toString (payload, true).toStdString());
        checkUntouched (*sequence, line);
    }
}

TEST (bridge_step_sequence_rejects_too_many_steps_without_touching_dest)
{
    juce::Array<juce::var> steps;
    for (int s = 0; s <= seq::kMaxSteps; ++s)
        steps.add (juce::var (juce::Array<juce::var> { 60 }));

    auto* payload = new juce::DynamicObject();
    payload->setProperty ("steps", steps);
    checkRejected (juce::var (payload), __LINE__);
}

TEST (bridge_step_sequence_rejects_too_many_notes_in_a_step_without_touching_dest)
{
    juce::Array<juce::var> chord;
    for (int n = 0; n <= seq::kMaxNotesPerStep; ++n)
        chord.add (40 + n);

    // The oversized step comes last, after steps that parsed fine.
    juce::Array<juce::var> steps;
    steps.add (juce::var (juce::Array<juce::var> { 60 }));
    steps.add (juce::var (chord));

    auto* payload = new juce::DynamicObject();
    payload->setProperty ("steps", steps);
    checkRejected (juce::var (payload), __LINE__);
}

TEST (bridge_step_sequence_rejects_malformed_payloads_without_touching_dest)
{
    checkRejected (juce::var(), __LINE__);
    checkRejected (juce::var (60), __LINE__);
    checkRejected (juce::var ("steps"), __LINE__);
    checkRejected (seqPayload ("[]"), __LINE__);
    checkRejected (seqPayload ("{}"), __LINE__);
    checkRejected (seqPayload (R"({"stepsPerBeat":2})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":null})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":"60"})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":{"a":1}})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60],"x"]})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60],null]})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60],[{"d":0.5}]]})"), __LINE__);        // a note without a pitch
    checkRejected (seqPayload (R"({"steps":[[60],[{"n":"x"}]]})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60],[{"n":61,"p":"often"}]]})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60],[[61]]]})"), __LINE__);             // chords do not nest
    checkRejected (seqPayload (R"({"steps":[[60]],"stepsPerBeat":"fast"})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60]],"durationMs":[1]})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60]],"legato":"yes"})"), __LINE__);
    checkRejected (seqPayload (R"({"steps":[[60]],"tag":{}})"), __LINE__);
}

// ---- midi -------------------------------------------------------------------------

TEST (bridge_midi_examples)
{
    const auto examples = examplesOf (loadContract()["jsToCpp"]["midi"]);
    REQUIRE (examples.size() > 0);
    CHECK_EQ (examples.size(), 4);

    auto find = [&] (const juce::String& name) -> juce::var
    {
        for (const auto& e : examples)
            if (e["name"].toString() == name)
                return e["payload"];
        return {};
    };

    seq::ImmediateEvent e;

    REQUIRE (bridge::parseMidi (find ("noteOn"), e));
    CHECK_EQ (static_cast<int> (e.type), static_cast<int> (seq::ImmediateEvent::NoteOn));
    CHECK_EQ (static_cast<int> (e.note), 60);
    CHECK_EQ (static_cast<int> (e.velocity), 100);
    CHECK_EQ (static_cast<int> (e.channel), 1);

    REQUIRE (bridge::parseMidi (find ("noteOff"), e));
    CHECK_EQ (static_cast<int> (e.type), static_cast<int> (seq::ImmediateEvent::NoteOff));
    CHECK_EQ (static_cast<int> (e.note), 60);
    CHECK_EQ (static_cast<int> (e.channel), 1);

    REQUIRE (bridge::parseMidi (find ("gatedNote"), e));
    CHECK_EQ (static_cast<int> (e.type), static_cast<int> (seq::ImmediateEvent::Note));
    CHECK_EQ (static_cast<int> (e.note), 67);
    CHECK_EQ (static_cast<int> (e.velocity), 90);
    CHECK (isAbout (e.durationMs, 200.0));

    REQUIRE (bridge::parseMidi (find ("allNotesOff"), e));
    CHECK_EQ (static_cast<int> (e.type), static_cast<int> (seq::ImmediateEvent::AllNotesOff));
}

TEST (bridge_midi_clamps_and_rejects)
{
    seq::ImmediateEvent e;
    REQUIRE (bridge::parseMidi (seqPayload (R"({"type":"noteOn","note":200,"velocity":0,"channel":40,"durationMs":0})"), e));
    CHECK_EQ (static_cast<int> (e.note), 127);
    CHECK_EQ (static_cast<int> (e.velocity), 1);
    CHECK_EQ (static_cast<int> (e.channel), 16);

    REQUIRE (bridge::parseMidi (seqPayload (R"({"type":"noteOn","note":-4,"velocity":500,"channel":0,"durationMs":0})"), e));
    CHECK_EQ (static_cast<int> (e.note), 0);
    CHECK_EQ (static_cast<int> (e.velocity), 127);
    CHECK_EQ (static_cast<int> (e.channel), 1);

    // durationMs only means something for `note`.
    REQUIRE (bridge::parseMidi (seqPayload (R"({"type":"noteOn","note":60,"velocity":100,"channel":1,"durationMs":500})"), e));
    CHECK (isAbout (e.durationMs, 0.0));
    REQUIRE (bridge::parseMidi (seqPayload (R"({"type":"note","note":60,"velocity":100,"channel":1,"durationMs":500})"), e));
    CHECK (isAbout (e.durationMs, 500.0));

    // A rejected payload leaves the destination alone.
    e.note = 99;
    CHECK (! bridge::parseMidi (seqPayload (R"({"type":"pitchBend","note":1})"), e));
    CHECK (! bridge::parseMidi (seqPayload (R"({"type":"noteOn"})"), e));
    CHECK (! bridge::parseMidi (seqPayload (R"({"note":60})"), e));
    CHECK (! bridge::parseMidi (seqPayload (R"({"type":"noteOn","note":"C4"})"), e));
    CHECK (! bridge::parseMidi (juce::var(), e));
    CHECK (! bridge::parseMidi (juce::var ("noteOn"), e));
    CHECK_EQ (static_cast<int> (e.note), 99);
}

// ---- saved state --------------------------------------------------------------------

namespace
{
    juce::StringArray keysOf (const std::map<juce::String, juce::String>& web)
    {
        juce::StringArray keys;
        for (const auto& [key, value] : web)
            keys.add (key);
        return keys;
    }

    juce::StringArray stringsOf (const juce::var& array)
    {
        juce::StringArray result;
        if (const auto* a = array.getArray())
            for (const auto& v : *a)
                result.add (v.toString());
        return result;
    }
}

TEST (bridge_persisted_examples_parse)
{
    const auto examples = examplesOf (loadContract()["persisted"]);
    REQUIRE (examples.size() > 0);
    CHECK_EQ (examples.size(), 3);

    for (const auto& example : examples)
    {
        const auto name = example["name"].toString().toStdString();

        bridge::PluginState state;
        const bool ok = bridge::parseState (juce::JSON::toString (example["blob"], true), state);
        if (! ok)
            check::fail (__FILE__, __LINE__, "parseState rejected " + name);
        if (! ok)
            continue;

        CHECK_EQ (keysOf (state.web).joinIntoString (","), stringsOf (example["expect"]["webKeys"]).joinIntoString (","));
        CHECK_EQ (state.sequence.isObject(), static_cast<bool> (example["expect"]["hasSequence"]));

        // The web values are the strings the blob held, untouched.
        const auto webSource = example["blob"].hasProperty ("v") ? example["blob"]["web"] : example["blob"];
        for (const auto& [key, value] : state.web)
            CHECK_EQ (value, webSource[juce::Identifier (key)].toString());
    }
}

TEST (bridge_persisted_v2_sequence_goes_through_the_sequence_parser)
{
    const auto examples = examplesOf (loadContract()["persisted"]);
    REQUIRE (examples.size() > 0);

    bridge::PluginState state;
    REQUIRE (bridge::parseState (juce::JSON::toString (examples[1]["blob"], true), state));

    auto sequence = makeSequence();
    REQUIRE (bridge::parseStepSequence (state.sequence, *sequence));
    CHECK_EQ (sequence->numSteps, 3);
    CHECK_EQ (static_cast<int> (sequence->steps[2].notes[0].note), 67);
    CHECK_EQ (sequence->tag, 1001);
}

TEST (bridge_serialise_state_writes_v2_and_round_trips)
{
    const auto examples = examplesOf (loadContract()["persisted"]);
    REQUIRE (examples.size() > 0);

    for (const auto& example : examples)
    {
        bridge::PluginState state;
        REQUIRE (bridge::parseState (juce::JSON::toString (example["blob"], true), state));

        const auto text   = bridge::serialiseState (state);
        const auto parsed = juce::JSON::parse (text);

        REQUIRE (parsed.isObject());
        CHECK (parsed["v"].isInt());
        CHECK_EQ (static_cast<int> (parsed["v"]), 2);
        CHECK (parsed["web"].isObject());
        CHECK (parsed.hasProperty ("sequence"));
        CHECK_EQ (parsed["sequence"].isObject(), state.sequence.isObject());
        if (! state.sequence.isObject())
            CHECK (parsed["sequence"].isVoid());   // written as null

        bridge::PluginState again;
        REQUIRE (bridge::parseState (text, again));
        CHECK (again.web == state.web);
        CHECK (sameJson (again.sequence, state.sequence));
        CHECK_EQ (bridge::serialiseState (again), text);
    }
}

TEST (bridge_serialise_state_keeps_awkward_strings)
{
    bridge::PluginState state;
    state.web["shell"]  = juce::String::fromUTF8 (R"({"a":"quote \" and \\ slash","b":"line\nbreak","c":"café ☃"})");
    state.web["empty"]  = "";
    state.web["a b/c"]  = "x";

    bridge::PluginState back;
    REQUIRE (bridge::parseState (bridge::serialiseState (state), back));
    CHECK (back.web == state.web);
}

TEST (bridge_parse_state_v1_ignores_what_is_not_a_json_string)
{
    bridge::PluginState state;
    REQUIRE (bridge::parseState (R"({"shell":"{}","stray":5,"obj":{"a":1}})", state));
    CHECK_EQ (state.web.size(), size_t (1));
    CHECK (state.web.count ("shell") == 1);
    CHECK (! state.sequence.isObject());
}

TEST (bridge_parse_state_rejects_what_it_cannot_read_and_leaves_dest_alone)
{
    bridge::PluginState keep;
    keep.web["kept"] = "yes";

    for (const char* text : { "", "   ", "not json", "{", "[]", "42", "\"v\"", "null",
                              R"({"v":2})",                          // v2 needs web
                              R"({"v":2,"web":[]})",
                              R"({"v":2,"web":"x"})",
                              R"({"v":3,"web":{}})",                 // a version we do not know
                              R"({"v":2.5,"web":{}})" })
    {
        bridge::PluginState state = keep;
        const bool ok = bridge::parseState (text, state);
        if (ok)
            check::fail (__FILE__, __LINE__, std::string ("accepted: ") + text);
        CHECK (state.web == keep.web);
    }
}

TEST (bridge_parse_state_v2_without_a_usable_sequence)
{
    bridge::PluginState state;
    REQUIRE (bridge::parseState (R"({"v":2,"web":{"shell":"{}"},"sequence":5})", state));
    CHECK (! state.sequence.isObject());
    CHECK_EQ (state.web.size(), size_t (1));

    REQUIRE (bridge::parseState (R"({"v":2,"web":{},"sequence":[1,2]})", state));
    CHECK (state.sequence.isVoid());   // an array is not a sequence payload
    CHECK (state.web.empty());

    // A key called "v" in a v1 blob is an experiment id like any other.
    REQUIRE (bridge::parseState (R"({"v":"{\"x\":1}","shell":"{}"})", state));
    CHECK_EQ (state.web.size(), size_t (2));
    CHECK (state.web.count ("v") == 1);
}

// ---- C++ to JS --------------------------------------------------------------------------

TEST (bridge_make_tick_matches_every_fixture_example)
{
    const auto examples = examplesOf (loadContract()["cppToJs"]["tick"]);
    REQUIRE (examples.size() > 0);
    CHECK_EQ (examples.size(), 3);

    for (const auto& example : examples)
    {
        const auto payload = example["payload"];

        bridge::Tick tick;
        tick.bpm                = payload["bpm"];
        tick.beatPosition       = payload["beatPosition"];
        tick.isPlaying          = payload["isPlaying"];
        tick.timeSigNumerator   = payload["timeSigNumerator"];
        tick.timeSigDenominator = payload["timeSigDenominator"];

        std::vector<seq::StepEvent> steps;
        const auto stepList = payload["steps"];
        for (const auto& s : *stepList.getArray())
        {
            seq::StepEvent e;
            e.index        = s["i"];
            e.stepsPerBeat = s["spb"];
            e.tag          = s["tag"];
            e.numPlayed    = s["played"].size();
            for (int n = 0; n < e.numPlayed; ++n)
                e.played[static_cast<size_t> (n)] = static_cast<uint8_t> (static_cast<int> (s["played"][n]));
            steps.push_back (e);
        }

        const auto made = bridge::makeTick (tick, steps.data(), static_cast<int> (steps.size()));

        // Compare what the page would receive, not the in-memory var.
        if (! sameJson (throughJson (made), payload))
            check::fail (__FILE__, __LINE__, "tick differs from fixture " + example["name"].toString().toStdString()
                                              + ": " + juce::JSON::toString (made, true).toStdString());

        CHECK (made["isPlaying"].isBool());
        CHECK (made["steps"].isArray());
    }
}

TEST (bridge_make_tick_without_steps_and_with_bad_numbers)
{
    bridge::Tick tick;
    tick.bpm          = std::nan ("");
    tick.beatPosition = INFINITY;

    const auto made = throughJson (bridge::makeTick (tick, nullptr, 5));
    REQUIRE (made.isObject());
    CHECK (isAbout (static_cast<double> (made["bpm"]), 120.0));
    CHECK (isAbout (static_cast<double> (made["beatPosition"]), 0.0));
    CHECK_EQ (made["steps"].size(), 0);

    // A step with more "played" notes than fit is cut to what exists.
    seq::StepEvent e;
    e.numPlayed = 9999;
    const auto clipped = bridge::makeTick (bridge::Tick(), &e, 1);
    CHECK_EQ (clipped["steps"][0]["played"].size(), seq::kMaxNotesPerStep);
}

TEST (bridge_make_state_matches_every_fixture_example)
{
    const auto examples = examplesOf (loadContract()["cppToJs"]["state"]);
    REQUIRE (examples.size() > 0);
    CHECK_EQ (examples.size(), 2);

    for (const auto& example : examples)
    {
        std::map<juce::String, juce::String> web;
        const auto source = example["payload"]["web"];
        if (auto* object = source.getDynamicObject())
            for (const auto& p : object->getProperties())
                web[p.name.toString()] = p.value.toString();

        const auto made = bridge::makeState (web);
        if (! sameJson (throughJson (made), example["payload"]))
            check::fail (__FILE__, __LINE__, "state differs from fixture " + example["name"].toString().toStdString());

        CHECK (made["web"].isObject());
    }
}
