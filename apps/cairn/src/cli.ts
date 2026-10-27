#!/usr/bin/env bun
import { runControl } from "./roles/control";
import { runWorker } from "./roles/worker";

const VERSION = "0.29.0-m18c";

function usage(): void {
  console.log(`cairn (merged) ${VERSION}

usage:
  cairn serve [options]             control plane: HTTP API + graph store (--config adds the scheduler)
  cairn worker --task <file>        run one task inside the project sandbox
  cairn version                     print the version
`);
}

const [command, ...rest] = Bun.argv.slice(2);

let code: number;
switch (command) {
  case "version":
    console.log(`cairn ${VERSION}`);
    code = 0;
    break;
  case "serve":
    code = await runControl(rest);
    break;
  case "worker":
    code = await runWorker(rest);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    usage();
    code = 0;
    break;
  default:
    console.error(`unknown command: ${command}`);
    usage();
    code = 2;
    break;
}

process.exit(code);
