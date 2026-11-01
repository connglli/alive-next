// What every test file gets before it loads, as bunfig.toml asks.
//
// Most tests drive the toolchain, which takes a few seconds a test here and longer
// on a slower or busier machine, where bun's default of five seconds would stop
// tests that pass. A test that needs more than this names its own limit.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(60_000);
