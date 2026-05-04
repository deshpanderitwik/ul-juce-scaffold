#include "PluginEditor.h"
#include "BinaryData.h"

// =============================================================================
// MIME type lookup for the resource provider.
// =============================================================================
static juce::String getMimeType (const juce::String& filename)
{
    if (filename.endsWithIgnoreCase (".html")) return "text/html";
    if (filename.endsWithIgnoreCase (".js"))   return "application/javascript";
    if (filename.endsWithIgnoreCase (".css"))  return "text/css";
    if (filename.endsWithIgnoreCase (".json")) return "application/json";
    if (filename.endsWithIgnoreCase (".png"))  return "image/png";
    if (filename.endsWithIgnoreCase (".svg"))  return "image/svg+xml";

    if (filename.endsWithIgnoreCase (".jpg")
        || filename.endsWithIgnoreCase (".jpeg"))
        return "image/jpeg";

    return "application/octet-stream";
}

// =============================================================================
// Build the WebBrowserComponent options.
// This is a static helper so we can call it in the initialiser list.
// =============================================================================
juce::WebBrowserComponent::Options
PluginEditor::createBrowserOptions (PluginProcessor& proc)
{
    using Options  = juce::WebBrowserComponent::Options;
    using Resource = juce::WebBrowserComponent::Resource;

    return Options{}
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withNativeIntegrationEnabled()

        // ---- JS → C++ : receive MIDI events from the web view ---------------
        .withEventListener ("sendMidiEvent", [&proc] (const juce::var& payload)
        {
            MidiEventData evt;

            auto typeStr = payload["type"].toString();

            if (typeStr == "noteOn")
                evt.type = MidiEventData::NoteOn;
            else if (typeStr == "noteOff")
                evt.type = MidiEventData::NoteOff;
            else
                return;

            evt.note     = static_cast<int> (payload["note"]);
            evt.velocity = static_cast<int> (payload["velocity"]);
            evt.channel  = static_cast<int> (payload["channel"]);

            proc.pushMidiEvent (evt);
        })

        // ---- JS → C++ : receive step sequence updates -----------------------
        .withEventListener ("setStepSequence", [&proc] (const juce::var& payload)
        {
            auto* notesArray = payload["notes"].getArray();
            if (notesArray == nullptr)
                return;

            std::vector<int> notes;
            notes.reserve (static_cast<size_t> (notesArray->size()));
            for (const auto& n : *notesArray)
                notes.push_back (static_cast<int> (n));

            int    multiplier = static_cast<int> (payload["subdivision"]);
            double durationMs = static_cast<double> (payload["durationMs"]);

            if (multiplier < 1) multiplier = 2;
            if (durationMs <= 0.0) durationMs = 150.0;

            proc.setStepSequence (std::move (notes), multiplier, durationMs);
        })

        // ---- Serve web assets ------------------------------------------------
        // Debug: read from the source web/ directory (live reload).
        // Release: read from BinaryData (self-contained binary).
        .withResourceProvider ([] (const juce::String& url)
            -> std::optional<Resource>
        {
            // Map "/" to "index.html"; otherwise extract the filename
            auto filename = (url == "/")
                ? juce::String ("index.html")
                : url.fromLastOccurrenceOf ("/", false, false);

          #if JUCE_DEBUG
            // Derive web/ from this source file: src/PluginEditor.cpp → ../web/
            auto webDir = juce::File (__FILE__)
                              .getParentDirectory()
                              .getParentDirectory()
                              .getChildFile ("web");
            auto devFile = webDir.getChildFile (filename);

            if (devFile.existsAsFile())
            {
                juce::MemoryBlock mb;
                devFile.loadFileAsData (mb);
                auto* raw = static_cast<const std::byte*> (
                                static_cast<const void*> (mb.getData()));
                return Resource {
                    std::vector<std::byte> (raw, raw + mb.getSize()),
                    getMimeType (filename)
                };
            }
          #endif

            // Fall back to BinaryData
            for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
            {
                if (filename == BinaryData::getNamedResourceOriginalFilename (
                                    BinaryData::namedResourceList[i]))
                {
                    int size = 0;
                    auto* data = BinaryData::getNamedResource (
                                     BinaryData::namedResourceList[i], size);

                    if (data != nullptr)
                    {
                        auto* raw = reinterpret_cast<const std::byte*> (data);
                        return Resource {
                            { raw, raw + size },
                            getMimeType (filename)
                        };
                    }
                }
            }

            return std::nullopt;
        });
}

// =============================================================================
// Constructor
// =============================================================================
PluginEditor::PluginEditor (PluginProcessor& p)
    : AudioProcessorEditor (p),
      processorRef (p),
      browser (createBrowserOptions (p))
{
    setSize (900, 600);
    setResizable (false, false);

    addAndMakeVisible (browser);

    // Navigate to the resource provider root — this triggers a request for "/"
    // which our resource provider answers with index.html.
    browser.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    // Start the transport-state timer at ~60 fps (16 ms interval).
    startTimerHz (60);
}

PluginEditor::~PluginEditor()
{
    stopTimer();
}

// =============================================================================
// Layout — the web view fills the entire editor window.
// =============================================================================
void PluginEditor::resized()
{
    browser.setBounds (getLocalBounds());
}

// =============================================================================
// Timer — push transport state from the atomic struct into the web view.
// Runs on the message thread at ~60 fps.
// =============================================================================
void PluginEditor::timerCallback()
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("bpm",              processorRef.transportState.bpm.load (std::memory_order_relaxed));
    obj->setProperty ("beatPosition",     processorRef.transportState.beatPosition.load (std::memory_order_relaxed));
    obj->setProperty ("isPlaying",        processorRef.transportState.isPlaying.load (std::memory_order_relaxed));
    obj->setProperty ("timeSigNumerator", processorRef.transportState.timeSigNumerator.load (std::memory_order_relaxed));
    obj->setProperty ("timeSigDenominator", processorRef.transportState.timeSigDenominator.load (std::memory_order_relaxed));
    obj->setProperty ("sessionId",          processorRef.sessionId);

    browser.emitEventIfBrowserIsVisible ("transportState", juce::var (obj));
}
