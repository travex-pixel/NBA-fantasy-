// Bundles the ES modules into a single self-contained dist/index.html (works from file:// and as a hosted artifact).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const strip = s => s.replace(/^\s*import .*?;\s*$/gm, '').replace(/^export (const|function|let|class) /gm, '$1 ').replace(/^export \{[^}]*\};?\s*$/gm, '');
const engine = strip(readFileSync('src/engine.js', 'utf8'));
const data = strip(readFileSync('src/data.js', 'utf8'));
const sources = strip(readFileSync('src/sources.js', 'utf8'));
let app = strip(readFileSync('src/app.js', 'utf8'));
// app.js references the engine as E.* — provide the namespace object.
const names = [...engine.matchAll(/^(?:const|function|let|class) ([A-Za-z_]\w*)/gm)].map(m => m[1]);
const ns = `const E = { ${[...new Set(names)].join(', ')} };`;
const js = `${engine}\n${data}\n${sources}\n${ns}\n${app}`;
const html = readFileSync('index.html', 'utf8').replace('<script type="module" src="./src/app.js"></script>', `<script>\n${js.replace(/<\/script>/g, '<\\/script>')}\n</script>`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
// Artifact variant: no document skeleton (the artifact host wraps it), same title/style/body/script.
const inner = html.replace(/^[\s\S]*?<title>/, '<title>').replace(/<\/head>\s*<body>/, '').replace(/<\/body>\s*<\/html>\s*$/, '');
writeFileSync('dist/artifact.html', inner);
console.log('dist/index.html', html.length, 'bytes; dist/artifact.html', inner.length, 'bytes');
