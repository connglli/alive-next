// The toolchain the suite drives, which is the one a run would drive.
//
// TOOLCHAIN overrides it for a single run, config.jsonc says where it is on
// this machine, and deps/ is where the build puts it otherwise; all three are
// loadConfig's business, so there is nothing to decide here.
import { loadConfig } from "../core/config.ts";
import { Toolchain } from "../core/toolchain.ts";

export const toolchain = new Toolchain(loadConfig().toolchain);
