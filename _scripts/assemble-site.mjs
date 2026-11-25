#!/usr/bin/env node
// Assemble le dossier publié par GitHub Pages (déploiement par GitHub Actions). Node 20+, aucune dépendance.
//
//   node _scripts/assemble-site.mjs              copie le site dans _site/
//   node _scripts/assemble-site.mjs --out=dir    autre dossier de sortie (tests)
//
// Copie TOUT le dépôt sauf les dossiers de travail (sources, config, scripts, données, CI, git,
// README), puis vérifie que les fichiers indispensables sont là : sans eux, le déploiement
// casserait le domaine, la vérification AdMob, les favicons ou les pages à la main.
// Sort en code 1 s'il manque quelque chose : le workflow ne déploie pas.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const OUT = path.resolve(ROOT, outArg ? outArg.slice(6) : '_site');

// Jamais publiés.
const EXCLUS = new Set(['_src', '_config', '_scripts', '_data', '_preview', '_site', '.github', '.git', '.gitignore', '.gitattributes', 'README.md', 'node_modules']);
// Indispensables (chemins relatifs au dossier publié).
const REQUIS = [
  'CNAME', '.nojekyll', 'app-ads.txt', 'robots.txt', 'sitemap.xml', '404.html', 'index.html',
  'favicon.ico', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png',
  'logo-mark.png', 'logo-mark-88.png', 'logo-mark-88.webp', 'logo-mark-88.avif', 'og-default.jpg',
  'privacy/index.html', 'delete-account/index.html', 'auth/index.html', 'beta/index.html',
];

// Garde-fou : le dossier de sortie est vidé. Jamais la racine, un dossier parent ni un dossier du dépôt autre que _site.
{
  const versRoot = path.relative(OUT, ROOT);
  const depuisRoot = path.relative(ROOT, OUT);
  const parentOuRacine = !versRoot.startsWith('..') || path.isAbsolute(versRoot);
  const dansLeDepot = !depuisRoot.startsWith('..') && !path.isAbsolute(depuisRoot);
  if (parentOuRacine || (dansLeDepot && depuisRoot.split(path.sep)[0] !== '_site')) {
    console.error(`✗ assemble-site : dossier de sortie refusé (${OUT}) : _site/ ou un dossier hors du dépôt`);
    process.exit(1);
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
const outRel = path.relative(ROOT, OUT).split(path.sep)[0];
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (EXCLUS.has(e.name) || e.name === outRel) continue;
  if (e.isSymbolicLink()) { console.log(`! assemble-site : lien symbolique ignoré (${e.name})`); continue; }
  fs.cpSync(path.join(ROOT, e.name), path.join(OUT, e.name), { recursive: true, dereference: false });
  n++;
}

const manque = REQUIS.filter((f) => !fs.existsSync(path.join(OUT, f)));
// Chaque URL du sitemap doit exister dans le dossier publié.
const sitemap = fs.existsSync(path.join(OUT, 'sitemap.xml')) ? fs.readFileSync(path.join(OUT, 'sitemap.xml'), 'utf8') : '';
for (const m of sitemap.matchAll(/<loc>https:\/\/[^/]+(\/[^<]*)<\/loc>/g)) {
  const f = m[1] === '/' ? 'index.html' : m[1].replace(/^\//, '') + (m[1].endsWith('/') ? 'index.html' : '');
  if (!fs.existsSync(path.join(OUT, f))) manque.push(`${f} (URL du sitemap)`);
}
const fuites = [...EXCLUS].filter((d) => fs.existsSync(path.join(OUT, d)));

if (manque.length || fuites.length) {
  for (const f of manque) console.error(`✗ assemble-site : manquant dans ${path.relative(ROOT, OUT)}/ : ${f}`);
  for (const f of fuites) console.error(`✗ assemble-site : ${f} ne doit pas être publié`);
  process.exit(1);
}
const pages = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
    else if (e.name.endsWith('.html')) pages.push(rel + e.name);
  }
})(OUT, '');
console.log(`assemble-site : ${n} entrée(s) copiée(s) dans ${path.relative(ROOT, OUT) || '.'}/, ${pages.length} page(s) HTML, ${REQUIS.length} fichiers indispensables présents, ${sitemap.match(/<loc>/g)?.length || 0} URL du sitemap vérifiées.`);
