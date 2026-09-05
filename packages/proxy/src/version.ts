import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** The package version, read from package.json so releases cannot drift. */
export const PROXY_VERSION: string = pkg.version;
