#include "../check.h"
#include "NoteScheduler.h"

// Scaffold smoke test: proves the target builds and links. Unit C replaces
// this file with the real scheduler suite.
TEST (scheduler_scaffold_links)
{
    seq::NoteScheduler scheduler;
    scheduler.prepare (48000.0);
    CHECK (! scheduler.anyHeld());
}
