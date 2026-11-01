# Questions and answers

This document provides short answers to common questions about alive-next.

## Does a loop need a finite bound or guaranteed progress?

No. We cut a loop at its header and prove it by induction: alive2 checks that one iteration of the tgt refines one iteration of the src, and induction extends that to any number of iterations ([docs/design.md](./design.md#decomposition--outlining)). We never prove or assume that a loop ends, so an event loop that waits for messages forever, such as a window's or a server's, is handled like any other loop.

The catch is that the two loops have to go around together. If the tgt deletes a loop without a fixed trip count, or replaces it with a call such as `memset`, alive-next cannot prove it ([docs/design.md](./design.md#scope)).

## How many attributes can alive-next handle?

Every attribute alive2 understands: about thirty, on functions, parameters and return values, listed in [llops/src/attrs.cpp](../llops/src/attrs.cpp). Each means what alive2 takes it to mean, and [docs/semantics.md](./semantics.md) says where that differs from the LangRef.

alive-next ignores the other attributes, as alive2 does, except on a parameter. alive2 rejects a parameter attribute it does not understand, such as `noalias`, so alive-next rejects the program too.
