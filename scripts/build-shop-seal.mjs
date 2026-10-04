import { build } from 'esbuild';
await build({entryPoints:['web/shop-seal.src.ts'],bundle:true,format:'iife',target:'es2020',minify:true,outfile:'web/shop-seal.bundle.js'});
