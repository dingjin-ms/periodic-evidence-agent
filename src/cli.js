#!/usr/bin/env node
import { help } from './cli-help.js';

if ((process.argv[2] ?? 'help') === 'help') console.log(help);
else if (!await (await import('./request-phase-cli.js')).ownRequestPhase(process.argv.slice(2)))
  await import('./cli-runtime.js');
