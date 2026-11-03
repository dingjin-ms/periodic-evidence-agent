#!/usr/bin/env node
import { help } from './cli-help.js';

if ((process.argv[2] ?? 'help') === 'help') console.log(help);
else await import('./cli-runtime.js');
