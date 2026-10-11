#include "PluginEditor.h"
#include "Bridge.h"
#include "ScaffoldConfig.h"
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
PluginEditor::createBrowserOptions (PluginProcessor& proc, PluginEditor& editor)
{
    // NOTE: `editor` is not fully constructed yet (this runs in the browser
    // member's initialiser). The lambdas only dereference it when events
    // arrive from the loaded page, long after construction completes.
    using Options  = juce::WebBrowserComponent::Options;
    using Resource = juce::WebBrowserComponent::Resource;

    return Options{}
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withNativeIntegrationEnabled()

        // ---- JS → C++ : the page is up and listening --------------------------
        // Whatever the previous page had sounding is gone with it, so release
        // it. The step sequence is not touched: it plays whether or not a page
        // exists.
        .withEventListener ("pageLoaded", [&proc, &editor] (const juce::var&)
        {
            proc.pageLoaded();
            proc.editorAttached();
            editor.pageIsLoaded = true;
            editor.sendState();
        })

        // ---- JS → C++ : immediate notes ---------------------------------------
        .withEventListener ("midi", [&proc] (const juce::var& payload)
        {
            seq::ImmediateEvent event;

            if (bridge::parseMidi (payload, event))
                proc.pushImmediate (event);
        })

        // ---- JS → C++ : step sequence updates ---------------------------------
        .withEventListener ("setStepSequence", [&proc] (const juce::var& payload)
        {
            if (! proc.setStepSequence (payload))
                juce::Logger::writeToLog ("setStepSequence: payload rejected");
        })

        // ---- JS → C++ : persist experiment state -------------------------------
        .withEventListener ("saveState", [&proc] (const juce::var& payload)
        {
            auto key = payload["key"].toString();
            if (key.isEmpty())
                return;
            proc.setWebState (key, payload["value"].toString());
        })

        // ---- JS → C++ : uncaught page errors -----------------------------------
        .withEventListener ("jsError", [] (const juce::var& payload)
        {
            juce::Logger::writeToLog ("JS error: " + payload["message"].toString()
                                      + " (" + payload["source"].toString()
                                      + ":" + payload["line"].toString() + ")");
        })

        // ---- Serve web assets --------------------------------------------------
        // Dev builds read web/ from the source tree (live reload); otherwise
        // the copy bundled into the binary is served.
        .withResourceProvider ([] (const juce::String& url)
            -> std::optional<Resource>
        {
            // Map "/" to "index.html"; otherwise extract the filename
            auto filename = (url == "/")
                ? juce::String ("index.html")
                : url.fromLastOccurrenceOf ("/", false, false);

          #if SCAFFOLD_WEB_DEV
            const juce::File webDir (SCAFFOLD_WEB_DEV_DIR);
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
      browser (createBrowserOptions (p, *this))
{
    setSize (900, 600);
    setResizable (false, false);

    addAndMakeVisible (browser);

    // Navigate to the resource provider root — this triggers a request for "/"
    // which our resource provider answers with index.html.
    browser.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    processorRef.addChangeListener (this);

    // Ticks go out at ~60 fps (16 ms interval).
    startTimerHz (60);
}

PluginEditor::~PluginEditor()
{
    stopTimer();
    processorRef.removeChangeListener (this);
    processorRef.editorDetached();
}

// =============================================================================
// Layout — the web view fills the entire editor window.
// =============================================================================
void PluginEditor::resized()
{
    browser.setBounds (getLocalBounds());
}

// =============================================================================
// State — the saved web state, sent when the page asks and again when the host
// restores a project under an open editor.
// =============================================================================
void PluginEditor::sendState()
{
    browser.emitEventIfBrowserIsVisible ("state", bridge::makeState (processorRef.getWebState()));
}

void PluginEditor::changeListenerCallback (juce::ChangeBroadcaster*)
{
    if (pageIsLoaded)
        sendState();
}

// =============================================================================
// Timer — one tick per frame: the transport, plus the step boundaries the
// sequencer crossed since the last one. Runs on the message thread at ~60 fps.
// =============================================================================
void PluginEditor::timerCallback()
{
    if (! pageIsLoaded)
        return;

    const int numSteps = processorRef.popStepEvents (stepScratch.data(), static_cast<int> (stepScratch.size()));

    const auto& transport = processorRef.transport;

    bridge::Tick tick;
    tick.bpm                = transport.bpm.load (std::memory_order_relaxed);
    tick.beatPosition       = transport.beatPosition.load (std::memory_order_relaxed);
    tick.isPlaying          = transport.isPlaying.load (std::memory_order_relaxed);
    tick.timeSigNumerator   = transport.timeSigNumerator.load (std::memory_order_relaxed);
    tick.timeSigDenominator = transport.timeSigDenominator.load (std::memory_order_relaxed);

    browser.emitEventIfBrowserIsVisible ("tick", bridge::makeTick (tick, stepScratch.data(), numSteps));
}
