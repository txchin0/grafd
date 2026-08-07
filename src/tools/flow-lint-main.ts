import { runFlowLint } from './flow-lint.js';

process.exitCode = await runFlowLint(process.argv.slice(2));
