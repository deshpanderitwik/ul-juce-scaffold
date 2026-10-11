#pragma once

// Minimal test harness — no dependencies.
//
//   TEST (name) { CHECK (x == 1); CHECK_EQ (a, b); REQUIRE (ptr != nullptr); }
//
// CHECK records a failure and carries on; REQUIRE records it and returns from
// the test. One main() per executable calls check::runAll (argc, argv); a
// command-line argument filters tests by substring.

#include <cstdio>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

namespace check
{

struct Case
{
    const char* name;
    void (*fn)();
};

inline std::vector<Case>& registry()
{
    static std::vector<Case> cases;
    return cases;
}

inline int& failures()
{
    static int count = 0;
    return count;
}

struct Registrar
{
    Registrar (const char* name, void (*fn)()) { registry().push_back ({ name, fn }); }
};

inline void fail (const char* file, int line, const std::string& what)
{
    ++failures();
    std::printf ("    FAIL %s:%d  %s\n", file, line, what.c_str());
}

template <typename A, typename B>
inline void checkEq (const A& a, const B& b, const char* aText, const char* bText,
                     const char* file, int line)
{
    if (a == b)
        return;

    std::ostringstream msg;
    msg << aText << " == " << bText << "   (" << a << " vs " << b << ")";
    fail (file, line, msg.str());
}

inline int runAll (int argc, char** argv)
{
    const char* filter = argc > 1 ? argv[1] : "";
    int run = 0, failed = 0;

    for (const auto& c : registry())
    {
        if (std::strstr (c.name, filter) == nullptr)
            continue;

        const int before = failures();
        c.fn();
        ++run;

        const bool ok = failures() == before;
        if (! ok)
            ++failed;
        std::printf ("%s  %s\n", ok ? "ok  " : "FAIL", c.name);
    }

    std::printf ("\n%d tests, %d failed\n", run, failed);
    return failed == 0 ? 0 : 1;
}

} // namespace check

#define TEST(name)                                                  \
    static void name();                                             \
    static check::Registrar checkRegistrar_##name (#name, name);    \
    static void name()

#define CHECK(cond)                                                 \
    do { if (! (cond)) check::fail (__FILE__, __LINE__, #cond); } while (false)

#define CHECK_EQ(a, b)                                              \
    check::checkEq ((a), (b), #a, #b, __FILE__, __LINE__)

#define REQUIRE(cond)                                               \
    do { if (! (cond)) { check::fail (__FILE__, __LINE__, #cond); return; } } while (false)
