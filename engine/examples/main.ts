// Running the examples by hand: `bun run examples [name ...]`, or all of them.
//
// The example list lives here with the examples, so this file knows it: the
// framework's prove() takes one scenario, and this is where the named ones
// come from.
import { prove } from "../core/prove.ts";
import { scenario, scenarios } from "./scenarios.ts";

const asked = process.argv.slice(2);
const chosen = asked.length > 0 ? asked.map(scenario) : scenarios;

let failed = 0;
for (const one of chosen) failed += (await prove(one)) ? 0 : 1;
process.exit(failed === 0 ? 0 : 1);
