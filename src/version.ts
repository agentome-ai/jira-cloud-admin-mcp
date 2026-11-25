import { readFileSync } from 'node:fs';

/** This package's version, as package.json gives it. */
export const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
