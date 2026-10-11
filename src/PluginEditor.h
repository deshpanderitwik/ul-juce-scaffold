#pragma once

#include "PluginProcessor.h"
#include <juce_gui_extra/juce_gui_extra.h>

class PluginEditor : public juce::AudioProcessorEditor,
                     private juce::Timer,
                     private juce::ChangeListener
{
public:
    explicit PluginEditor (PluginProcessor&);
    ~PluginEditor() override;

    void resized() override;

private:
    void timerCallback() override;

    // The processor restored its state (the host loaded a project) while this
    // editor was open.
    void changeListenerCallback (juce::ChangeBroadcaster*) override;

    // Hands the page the saved web state.
    void sendState();

    static juce::WebBrowserComponent::Options createBrowserOptions (PluginProcessor&, PluginEditor&);

    PluginProcessor& processorRef;
    juce::WebBrowserComponent browser;

    // Ticks start with the page's first pageLoaded; before that there is
    // nobody to listen.
    bool pageIsLoaded = false;

    std::array<seq::StepEvent, PluginProcessor::kStepQueueCapacity> stepScratch;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginEditor)
};
