#!/usr/bin/env node
// The `sayagain` command. Everything lives in @sayagain/proxy; this package exists so that
// `npx sayagain` and `npm install -g sayagain` work and the bare name cannot be squatted.
import { runCli } from "@sayagain/proxy/cli";

runCli();
