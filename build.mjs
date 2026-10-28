import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const license = await readFile(new URL('./THIRD_PARTY_LICENSES.txt', import.meta.url), 'utf8');
await build({
  entryPoints: ['src.mjs'], bundle: true, format: 'esm', platform: 'browser',
  external: ['cloudflare:workers'], minify: true, outfile: 'worker.js',
  // Generated JavaScript has no source TypeScript annotations. Check source separately.
  banner: { js: '// @ts-nocheck\n/*!\n' + license.trimEnd() + '\n*/' },
});
