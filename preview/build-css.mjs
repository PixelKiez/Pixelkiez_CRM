import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const source = readFileSync('preview/tailwind-src.css', 'utf8');
const result = await postcss([tailwindcss()]).process(source, { from: 'app/globals.css', to: 'preview/app.css' });
writeFileSync('preview/app.css', result.css);
console.log('CSS kompiliert:', result.css.length, 'Bytes');
