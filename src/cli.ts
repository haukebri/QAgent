#!/usr/bin/env node
import { cac } from "cac";
import { registerInitCommand } from "./commands/init.js";
import { registerRunCommand } from "./commands/run.js";

const cli = cac("qagent");

registerInitCommand(cli);
registerRunCommand(cli);

cli.help();
cli.version("0.0.0");

cli.parse();
