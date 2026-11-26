#!/usr/bin/env node
// Générateur du site dunkleague.app. Node 20+, aucune dépendance.
//
//   node _scripts/build.mjs            contrôle puis écrit les pages, sitemap.xml et 404.html
//   node _scripts/build.mjs --check    contrôle seulement, n'écrit rien
//   node _scripts/build.mjs --prune    supprime aussi les pages générées dont la source a disparu
//   node _scripts/build.mjs --hash "mot ou expression"   affiche l'empreinte à ajouter dans _config/lexique.json
//   node _scripts/build.mjs --today=2026-12-01            date du jour forcée (tests)
//   node _scripts/build.mjs --now=2026-11-25T16:00:00Z    instant forcé pour les blocs de données (tests)
//   node _scripts/build.mjs --sample                      données FICTIVES de _data/snapshot.sample.json, sortie dans _preview/
//   node _scripts/build.mjs --data=chemin.json            autre fichier de données (tests), sortie dans _preview/
//
// Sources : _src/pages/<chemin>.html (en-tête <!--meta {JSON} --> puis corps HTML).
// Sortie : <slug>/index.html à la racine du dépôt (accueil = index.html), sitemap.xml, 404.html.
// Données : _data/snapshot.json (écrit par _scripts/fetch-snapshot.mjs), marqueurs {{auto:…}}.
// Rien n'est écrit s'il reste une erreur. Voir README.md, sections « Générateur » et « Données de l'app ».

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as DONNEES from './donnees.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, '_src');
const PAGES_DIR = path.join(SRC_DIR, 'pages');
const CONFIG_DIR = path.join(ROOT, '_config');
const DATA_DIR = path.join(ROOT, '_data');
const STATE_FILE = path.join(CONFIG_DIR, 'build-state.json');
const GEN_MARK = '<meta name="generator" content="dunkleague-build">';
const CSS_MAX = 14 * 1024;

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const FLAG = (n) => argv.includes(n);
const todayArg = argv.find((a) => a.startsWith('--today='));
const TODAY = todayArg ? todayArg.slice(8) : new Date().toISOString().slice(0, 10);
// Instant de référence des blocs de données (nuit à venir, récap) : --now, sinon 16 h UTC le jour de --today, sinon maintenant.
const nowArg = argv.find((a) => a.startsWith('--now='));
const NOW = nowArg ? Date.parse(nowArg.slice(6)) : todayArg ? Date.parse(TODAY + 'T16:00:00Z') : Date.now();
const dataArg = argv.find((a) => a.startsWith('--data='));
const DATA_TEST = dataArg ? dataArg.slice(7) : FLAG('--sample') ? path.join('_data', 'snapshot.sample.json') : null;

// ---------------------------------------------------------------- rapport
const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where} : ${msg}`);
const warn = (where, msg) => warnings.push(`${where} : ${msg}`);

// ---------------------------------------------------------------- outils texte
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', rsquo: '’', lsquo: '‘', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—', middot: '·' };
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const stripComments = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '');
function visibleText(html) {
  return decode(stripComments(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function attrText(html) {
  const out = [];
  const re = /\s[a-z-]+="([^"]*)"/gi;
  let m;
  for (const tag of stripComments(html).match(/<[a-z][^>]*>/gi) || []) {
    re.lastIndex = 0;
    while ((m = re.exec(tag))) out.push(decode(m[1]));
  }
  return out.join(' ');
}
function norm(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokenize(text) {
  return String(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map((o) => ({ o, n: norm(o).replace(/ /g, '') })).filter((t) => t.n);
}
const countChars = (s) => [...decode(s)].length;
const words = (text) => String(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
function slugify(s) {
  return cutSlug(norm(visibleText(s)).replace(/ /g, '-'), 60) || 'section';
}
// Coupe un slug à max caractères sans couper un mot (sauf premier mot trop long).
function cutSlug(slug, max) {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const i = cut.lastIndexOf('-');
  return (i > 0 ? cut.slice(0, i) : slug.slice(0, max)).replace(/-+$/, '');
}
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
function dateLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`;
}
const dateShort = (iso) => iso.split('-').reverse().join('/');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- config
function readJson(file, where) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    err(where || path.relative(ROOT, file), `JSON illisible (${e.message})`);
    return null;
  }
}
const LEX = readJson(path.join(CONFIG_DIR, 'lexique.json')) || { sel: '', bloquant: [], alerte: [], marques: [], formesTolerees: { empreintes: [] }, exceptions: [], maxMotsExpression: 4 };
const lexHash = (normalized) => sha(LEX.sel + ':' + normalized);

if (FLAG('--hash')) {
  const words_ = argv.filter((a) => !a.startsWith('--'));
  for (const w of words_) {
    console.log(`${norm(w)}\t${lexHash(norm(w))}`);
    console.log(`  forme exacte (formesTolerees) : ${sha(LEX.sel + ':exact:' + w.toLowerCase())}`);
  }
  process.exit(0);
}

const SITE = readJson(path.join(CONFIG_DIR, 'site.json')) || {};
const BAREME = readJson(path.join(CONFIG_DIR, 'bareme.json')) || {};
const EXC = readJson(path.join(CONFIG_DIR, 'exceptions.json')) || { slugsMarqueTierce: {} };
const BASE = (SITE.baseUrl || 'https://dunkleague.app').replace(/\/$/, '');
const ID_ORG = BASE + '/#org';
const ID_WEBSITE = BASE + '/#website';
const ID_APP = BASE + '/#app';
const SET_BLOQ = new Set(LEX.bloquant);
const SET_ALERTE = new Set(LEX.alerte);
const SET_MARQUES = new Set(LEX.marques);
const SET_TOLER = new Set((LEX.formesTolerees && LEX.formesTolerees.empreintes) || []);
const LEX_EXC = LEX.exceptions || [];
const MAXN = LEX.maxMotsExpression || 4;

// ---------------------------------------------------------------- lexique
// Analyse mot par mot (et expressions de 2 à MAXN mots). Jamais de recherche dans les bouts de mots.
function scanLexique(text) {
  const toks = tokenize(text);
  const res = { bloq: [], alerte: [], marques: [], toler: [], capital: [] };
  for (let i = 0; i < toks.length; i++) {
    for (let n = 1; n <= MAXN && i + n <= toks.length; n++) {
      const slice = toks.slice(i, i + n);
      const key = slice.map((t) => t.n).join(' ');
      const h = lexHash(key);
      const shown = slice.map((t) => t.o).join(' ');
      const ctx = toks.slice(Math.max(0, i - 4), i + n + 4).map((t) => t.o).join(' ');
      if (SET_BLOQ.has(h)) {
        if (n === 1 && SET_TOLER.has(sha(LEX.sel + ':exact:' + slice[0].o.toLowerCase()))) {
          res.toler.push({ shown, ctx });
          continue;
        }
        const ex = n === 1 && LEX_EXC.find((e) => e.empreinte === h);
        if (ex && /^\p{Lu}\p{Ll}+$/u.test(slice[0].o)) { res.capital.push({ shown, ctx, ex }); continue; }
        res.bloq.push({ shown, ctx });
      } else if (SET_MARQUES.has(h)) res.marques.push({ shown, ctx });
      else if (SET_ALERTE.has(h)) res.alerte.push({ shown, ctx });
    }
  }
  return res;
}
// fullText : tout le fichier ; bodyText : texte visible du corps (seule zone où une exception peut jouer).
function reportLexique(where, fullText, bodyText, pagePath, { legacy = false } = {}) {
  const r = scanLexique(fullText);
  const fail = legacy ? (m) => warn(where, '[HÉRITÉ, à corriger à la migration] ' + m) : (m) => err(where, m);
  for (const f of r.bloq) fail(`mot proscrit « ${f.shown} » (… ${f.ctx} …)`);
  for (const f of r.marques) fail(`nom de marque ou de sponsor à ne pas écrire « ${f.shown} » (… ${f.ctx} …)`);
  for (const f of r.alerte) warn(where, `mot de la liste d'alerte « ${f.shown} », à relire (… ${f.ctx} …)`);
  for (const f of r.toler) warn(where, `forme proche d'un mot proscrit « ${f.shown} », tolérée mais à reformuler si possible (… ${f.ctx} …)`);
  if (r.capital.length) {
    const ex = r.capital[0].ex;
    const inBody = bodyText == null ? 0 : scanLexique(bodyText).capital.length;
    const ok = ex.pages.includes(pagePath) && inBody === r.capital.length && inBody <= ex.max;
    if (!ok) {
      const m = !ex.pages.includes(pagePath)
        ? `nom de la capitale interdit sur cette page (autorisé seulement dans le corps de ${ex.pages.join(', ')})`
        : `nom de la capitale : ${r.capital.length} occurrence(s) dans le fichier, ${inBody} dans le corps visible ; autorisé au plus ${ex.max} fois et seulement dans le corps (ni title, meta, H1, og, URL, attribut, JSON-LD, commentaire)`;
      fail(m);
    }
  }
}

// ---------------------------------------------------------------- données de l'app (vague 2)
// Trois modes :
//   live   : _data/snapshot.json valide (téléchargé par fetch-snapshot.mjs) ; sortie à la racine.
//   apercu : --sample ou --data=… (données fictives ou de test) ; sortie dans _preview/, jamais à la racine.
//   repli  : aucune donnée valide ; blocs de repli (chiffres figés vérifiés de _data/figees.json,
//            /ce-soir/ sans programme). Jamais de page vide, jamais de chiffre inventé.
const DONNEES_CONF = readJson(path.join(CONFIG_DIR, 'donnees.json')) || {};
const FIGEES = fs.existsSync(path.join(DATA_DIR, 'figees.json')) ? readJson(path.join(DATA_DIR, 'figees.json')) : null;
let SNAP = null;
let DATA_MODE = 'repli';
let DATA_FILE = null;
{
  const file = DATA_TEST ? path.resolve(ROOT, DATA_TEST) : path.join(DATA_DIR, 'snapshot.json');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (fs.existsSync(file)) {
    const snap = readJson(file, rel);
    const pb = snap ? DONNEES.validerSnapshot(snap) : ['illisible'];
    if (pb.length) {
      (DATA_TEST ? err : warn)(rel, `données refusées (${pb.slice(0, 5).join(' ; ')}${pb.length > 5 ? ` ; … ${pb.length - 5} autre(s)` : ''}) : blocs de repli`);
    } else {
      SNAP = snap;
      DATA_MODE = DATA_TEST ? 'apercu' : 'live';
      DATA_FILE = rel;
    }
  } else if (DATA_TEST) err(rel, 'fichier de données introuvable');
}
if (DATA_MODE === 'apercu') warn('données', `APERÇU avec ${DATA_FILE} (données fictives ou de test) : pages écrites dans _preview/, jamais à la racine du site`);
if (DATA_MODE === 'repli') warn('données', `pas de _data/snapshot.json valide : blocs de repli (chiffres figés vérifiés, /ce-soir/ sans programme). Pour l'obtenir : node _scripts/fetch-snapshot.mjs ; pour un aperçu fictif : --sample`);
if (SNAP) {
  const ageH = (NOW - Date.parse(SNAP.generated_at)) / 3600e3;
  const maxH = DONNEES_CONF.fraicheurMaxHeures || 36;
  if (ageH > maxH) warn('données', `instantané généré il y a ${Math.round(ageH)} h (plus de ${maxH} h) : /ce-soir/ le signale aux visiteurs`);
  if (ageH < -1) warn('données', `instantané daté du futur (${SNAP.generated_at})`);
  const label = DONNEES_CONF.saison && DONNEES_CONF.saison.label;
  if (label && SNAP.season.label !== label) warn('données', `saison « ${SNAP.season.label} » dans les données, « ${label} » dans _config/donnees.json`);
  const vide = DONNEES.controleExportVide(SNAP, NOW, DONNEES_CONF);
  if (vide) err('données', vide);
  // Instantané périmé : ses nuits ne couvrent ni J ni J+1 (actualisation en panne). Pas bloquant : /ce-soir/
  // affiche alors le message neutre « n'a pas pu être actualisé », jamais « pas de match ».
  {
    const J = DONNEES.dateNewYork(NOW);
    const S = DONNEES_CONF.saison || {};
    const couvre = (SNAP.nights || []).some((n) => n && (n.date === J || n.date === DONNEES.ajouterJours(J, 1)));
    if (!couvre && S.debut && J >= S.debut && J <= S.finSaisonReguliere) warn('données', `l'instantané ne couvre ni le ${J} ni le lendemain (nuits du ${(SNAP.nights[0] || {}).date || '?'} au ${(SNAP.nights.at(-1) || {}).date || '?'}) : /ce-soir/ affiche le message « programme non actualisé »`);
  }
  if (BAREME.mvp && BAREME.mvp.minMatchs !== 5) warn('données', `nights_5plus compte les nuits d'au moins 5 matchs, mais le barème met le MVP de la Night à ${BAREME.mvp.minMatchs} : adapter le contrat`);
}
// Le payload est publié en partie : ses textes passent par le lexique (clés exclues).
function scanDonnees(where, obj) {
  const r = scanLexique(DONNEES.textesDuPayload(obj));
  for (const f of [...r.bloq, ...r.capital]) err(where, `mot proscrit dans les données « ${f.shown} » (… ${f.ctx} …)`);
  for (const f of r.marques) err(where, `nom de marque ou de sponsor dans les données « ${f.shown} »`);
  for (const f of r.alerte) warn(where, `mot de la liste d'alerte dans les données « ${f.shown} »`);
}
if (SNAP) scanDonnees(DATA_FILE, SNAP);
if (FIGEES) scanDonnees('_data/figees.json', FIGEES);
if (DATA_FILE !== '_data/snapshot.sample.json' && fs.existsSync(path.join(DATA_DIR, 'snapshot.sample.json'))) {
  const s = readJson(path.join(DATA_DIR, 'snapshot.sample.json'));
  if (s) scanDonnees('_data/snapshot.sample.json', s);
}
const autoCtx = () => ({ snap: SNAP, mode: DATA_MODE, now: NOW, bareme: BAREME, donnees: DONNEES_CONF, figees: FIGEES, warn: (m) => warn('données', m) });
// Remplace les marqueurs {{auto:nom}} du corps par leur bloc, encadré de <!--auto:start-->…<!--auto:end-->
// (hors compte de mots et hors empreinte lastmod). Un marqueur produit un bloc : seul sur sa ligne.
function expandAuto(html, where) {
  if (!/\{\{\s*auto:/.test(html)) return html;
  if (/<p[^>]*>(?:(?!<\/p>)[\s\S])*\{\{\s*auto:/.test(html)) err(where, '{{auto:…}} produit un bloc : le placer seul sur sa ligne, hors d\'un <p>');
  const ctx = autoCtx();
  return html.replace(/\{\{\s*auto:([a-z0-9-]+)\s*\}\}/g, (m, name) => {
    const fn = DONNEES.MARQUEURS[name];
    if (!fn) { err(where, `marqueur inconnu ${m} (disponibles : ${Object.keys(DONNEES.MARQUEURS).map((k) => `auto:${k}`).join(', ')})`); return ''; }
    return `<!--auto:start-->${fn(ctx)}<!--auto:end-->`;
  });
}

// ---------------------------------------------------------------- marqueurs
function lookup(obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o != null && typeof o === 'object' ? o[k] : undefined), obj);
}
function storeIos(c) {
  let u = `${SITE.appStoreUrl}?ct=${encodeURIComponent(c)}&mt=8`;
  if (SITE.appStoreProviderToken) u += `&pt=${encodeURIComponent(SITE.appStoreProviderToken)}`;
  return u;
}
const storeAndroid = (c) => `${SITE.playUrl}&referrer=${encodeURIComponent(`utm_source=site&utm_campaign=${c}`)}`;
let badgeFallbackWarned = false;
function badgesHtml(c) {
  const b = SITE.badges || {};
  const has = (p) => p && fs.existsSync(path.join(ROOT, p.replace(/^\//, '')));
  const h = b.height || 52;
  const ios = has(b.ios)
    ? `<a class="store img" href="${escAttr(storeIos(c))}" data-store="ios" rel="noopener"><img src="${b.ios}" alt="Télécharger dans l'App Store" height="${h}"></a>`
    : `<a class="store" href="${escAttr(storeIos(c))}" data-store="ios" rel="noopener">Voir sur l'App Store</a>`;
  const and = has(b.android)
    ? `<a class="store img" href="${escAttr(storeAndroid(c))}" data-store="android" rel="noopener"><img src="${b.android}" alt="Disponible sur Google Play" height="${h}"></a>`
    : `<a class="store" href="${escAttr(storeAndroid(c))}" data-store="android" rel="noopener">Voir sur Google Play</a>`;
  if ((!has(b.ios) || !has(b.android)) && !badgeFallbackWarned) {
    badgeFallbackWarned = true;
    warn('badges', `badges officiels absents (${b.ios}, ${b.android}) : liens texte neutres provisoires (« Voir sur l'App Store », « Voir sur Google Play »), sans imitation de badge. TODO : déposer les badges officiels FR non modifiés.`);
  }
  return `<div class="stores">${ios}${and}</div>`;
}
function resolveMarkers(str, page, where) {
  if (str == null) return str;
  let s = String(str);
  for (let pass = 0; pass < 6 && /\{\{/.test(s); pass++) {
    s = s.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([a-z]+)\s*)?\}\}/g, (m, key, filter) => {
      let v;
      if (key === 'badges') return badgesHtml(page.ctaCampaign);
      if (key === 'store.ios') return escAttr(storeIos(page.ctaCampaign));
      if (key === 'store.android') return escAttr(storeAndroid(page.ctaCampaign));
      if (key === 'page.modifiedOn') v = page.modifiedOn;
      else if (key.startsWith('bareme.')) v = lookup(BAREME, key.slice(7));
      else if (key.startsWith('site.')) v = lookup(SITE, key.slice(5));
      if (v === undefined || v === null || typeof v === 'object') {
        err(where, `marqueur inconnu ${m}`);
        return '';
      }
      if (isIsoDate(v)) return filter === 'court' ? dateShort(v) : filter === 'iso' ? v : dateLong(v);
      if (filter && filter !== 'court' && filter !== 'iso') err(where, `filtre inconnu ${m}`);
      return String(v);
    });
  }
  if (/\{\{/.test(s)) err(where, 'marqueur non résolu (boucle ou syntaxe)');
  return s;
}

// ---------------------------------------------------------------- sources
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
function pathFromFile(file) {
  const rel = path.relative(PAGES_DIR, file).replace(/\\/g, '/').replace(/\.html$/, '');
  if (rel === 'index') return '/';
  if (rel.endsWith('/index')) return '/' + rel.slice(0, -6) + '/';
  return '/' + rel + '/';
}
const outFileFor = (p) => (p === '/' ? 'index.html' : p.slice(1) + 'index.html');
const absUrl = (p) => BASE + p;

const KNOWN_FIELDS = new Set(['title', 'description', 'h1', 'kicker', 'intro', 'heroNote', 'heroMedia', 'disclaimerTop', 'path', 'parent', 'crumb', 'breadcrumbs', 'related', 'relatedLabel', 'relatedBlurb', 'primaryQuery', 'forbiddenInTitle', 'schema', 'ogTitle', 'ogDescription', 'ogImage', 'ogImageAlt', 'ogType', 'noindex', 'draft', 'inMenu', 'modifiedOn', 'publishedOn', 'faq', 'faqTitle', 'ctaCampaign', 'heroBadges', 'stickyCta', 'toc', 'gabarit', 'replacesLegacy', 'minWords', 'preprod', 'introPour', 'dateFromData']);

const sources = walk(PAGES_DIR).filter((f) => f.endsWith('.html'));
for (const f of walk(PAGES_DIR)) if (!f.endsWith('.html') && !path.basename(f).startsWith('.')) warn(path.relative(ROOT, f), 'fichier ignoré (seuls les .html sont des pages)');
const pages = [];
for (const file of sources) {
  const where = path.relative(ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const m = raw.match(/^\s*<!--meta\s*([\s\S]*?)-->/);
  if (!m) { err(where, 'en-tête <!--meta {JSON} --> absent en tête de fichier'); continue; }
  let meta;
  try { meta = JSON.parse(m[1]); } catch (e) { err(where, `en-tête JSON invalide (${e.message})`); continue; }
  const p = pathFromFile(file);
  for (const k of Object.keys(meta)) if (!KNOWN_FIELDS.has(k) && !k.startsWith('_')) warn(where, `champ inconnu « ${k} » (ignoré)`);
  if (meta.path && meta.path !== p) err(where, `path « ${meta.path} » ne correspond pas au fichier (attendu « ${p} »)`);
  for (const seg of p.split('/').filter(Boolean)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg)) err(where, `segment d'URL « ${seg} » invalide (minuscules, chiffres, tirets)`);
  }
  if (/^\/_/.test(p) || p === '/404/') err(where, `chemin réservé ${p}`);
  pages.push({ file, where, raw, meta, body: raw.slice(m[0].length), path: p });
}

// ---------------------------------------------------------------- pages à la main sur disque
const generatedOnDisk = new Set();
const handOnDisk = new Map(); // path -> html
function scanDiskPages(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scanDiskPages(p, rel + e.name + '/');
    else if (e.name === 'index.html') {
      const html = fs.readFileSync(p, 'utf8');
      const urlPath = '/' + rel;
      if (html.includes(GEN_MARK)) generatedOnDisk.add(urlPath);
      else handOnDisk.set(urlPath, html);
    }
  }
}
scanDiskPages(ROOT);

const LEGACY = new Map(((SITE.legacy && SITE.legacy.pages) || []).map((l) => [l.path, l]));
const srcPaths = new Set(pages.map((p) => p.path));
const live = pages.filter((p) => !p.meta.draft);
const livePaths = new Set(live.map((p) => p.path));
// Pages à la main encore servies : sur disque, sans source non brouillon.
const legacyServed = new Map([...handOnDisk].filter(([p]) => !livePaths.has(p)));
// Brouillons dont aucune version n'est servie (une page à la main en cours de réécriture reste, elle, servie et liée).
const drafts = new Set(pages.filter((p) => p.meta.draft && !legacyServed.has(p.path)).map((p) => p.path));
const draftSources = pages.filter((p) => p.meta.draft).map((p) => p.path);
// Préproduction (plan, 5.3.8) : page générée et servie, mais noindex, hors sitemap, hors menu,
// hors pied de page, hors pages liées et sans lien depuis les autres pages.
const preprod = new Set(live.filter((p) => p.meta.preprod).map((p) => p.path));
for (const p of live.filter((x) => x.meta.preprod)) {
  if (p.meta.preprod !== true) err(p.where, 'preprod doit valoir true (ou être retiré)');
  if (!p.meta.noindex) err(p.where, 'une page en préproduction doit porter "noindex": true');
  if (p.meta.inMenu) err(p.where, 'une page en préproduction ne peut pas être dans le menu (inMenu)');
}
const isPublished = (p) => livePaths.has(p) || legacyServed.has(p);
const labelOf = (p) => {
  const pg = live.find((x) => x.path === p);
  if (pg) return pg.meta.crumb || visibleText(pg.meta.h1 || pg.meta.title);
  return (LEGACY.get(p) && LEGACY.get(p).crumb) || p;
};

for (const [p, html] of legacyServed) {
  const where = `page à la main ${p}`;
  const conf = LEGACY.get(p);
  const robots = (html.match(/<meta\s+name="robots"\s+content="([^"]*)"/i) || [])[1] || '';
  if (!conf) warn(where, 'non déclarée dans _config/site.json (legacy.pages) : hors sitemap');
  else if (!conf.indexable && !/noindex/i.test(robots)) warn(where, 'déclarée non indexable mais le fichier n\'a pas de meta robots noindex (à corriger lors de sa reprise)');
  else if (conf.indexable && /noindex/i.test(robots)) err(where, 'déclarée indexable dans site.json mais le fichier est en noindex');
  if (conf && conf.indexable && !isIsoDate(conf.lastmod)) err(where, 'lastmod manquant ou invalide dans site.json');
  if (draftSources.includes(p)) warn(where, 'une source brouillon existe : la page à la main reste servie');
  reportLexique(where, decode(html), visibleText(html), p, { legacy: true });
}
for (const p of LEGACY.keys()) if (!handOnDisk.has(p) && !livePaths.has(p)) warn(`site.json legacy ${p}`, 'fichier introuvable sur le disque');

// ---------------------------------------------------------------- liens vers les brouillons
function unwrapDraftLinks(html, where) {
  return html.replace(/<a\b([^>]*)\bhref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi, (all, a, href, b, inner) => {
    const target = href.replace(/^https:\/\/dunkleague\.app/, '').split('#')[0].split('?')[0];
    if (drafts.has(target)) {
      warn(where, `lien vers la page brouillon ${target} retiré (texte conservé)`);
      return inner;
    }
    if (preprod.has(target)) {
      warn(where, `lien vers la page en préproduction ${target} retiré (texte conservé)`);
      return inner;
    }
    return all;
  });
}

// ---------------------------------------------------------------- CSS
const CSS = `:root{--bg:#0c0e12;--card:#15181e;--border:#232833;--text:#f4f5f7;--muted:#98a0ac;--brand:#ff6b1a;--gold:#f5b94b;--gold2:#ffd27a;--ink:#171205;color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.65;font-size:1.0625rem}
a{color:var(--gold)}a:hover{color:var(--gold2)}
:focus-visible{outline:2px solid var(--gold);outline-offset:2px;border-radius:4px}
img{max-width:100%;height:auto}
.skip{position:absolute;left:-999px;top:8px;background:var(--gold);color:var(--ink);padding:8px 14px;border-radius:8px;z-index:30}.skip:focus{left:8px}
.bar{position:sticky;top:0;z-index:20;background:rgba(12,14,18,.94);border-bottom:1px solid var(--border)}
.bar-in{max-width:1080px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;flex-wrap:wrap;gap:8px 20px}
.brand{display:flex;align-items:center;gap:8px;color:var(--text);text-decoration:none;font-weight:800;font-size:1.1rem;letter-spacing:-.3px}
.brand picture{display:flex}.brand img{width:44px;height:30px}.brand em{font-style:normal;color:var(--gold)}
.menu{order:3;width:100%;display:flex;flex-wrap:wrap;gap:2px 18px;font-size:.95rem}
.menu a{color:var(--muted);text-decoration:none;padding:2px 0}.menu a:hover,.menu a[aria-current]{color:var(--text)}
.btn-dl{margin-left:auto;background:var(--gold);color:var(--ink);font-weight:700;text-decoration:none;padding:8px 18px;border-radius:999px;font-size:.95rem;white-space:nowrap}
.btn-dl:hover{background:var(--gold2);color:var(--ink)}
@media(min-width:760px){.menu{order:0;width:auto;margin-left:8px}}
.wrap{max-width:760px;margin:0 auto;padding:0 16px}
.crumbs{margin:20px 0 0;font-size:.85rem;color:var(--muted)}
.crumbs ol{list-style:none;display:flex;flex-wrap:wrap}.crumbs li+li::before{content:"›";margin:0 8px}
.crumbs a{color:var(--gold);text-decoration:none}
.hero{text-align:center;padding:28px 0 8px}
.kicker{font-size:.72rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);margin-bottom:10px}
h1{font-size:clamp(1.75rem,5.2vw,2.5rem);line-height:1.15;letter-spacing:-.5px;margin-bottom:14px;text-wrap:balance}
h1 em{font-style:normal;color:var(--gold)}
.intro{color:var(--muted);max-width:36em;margin:0 auto;font-size:1.08rem}.intro p{margin:0 0 10px}.intro strong{color:var(--text)}
.hero-note,.disclaimer{color:var(--muted);font-size:.82rem;max-width:40em;margin:12px auto}
.hero-media{margin-top:24px}
.stores{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin:22px 0 6px}
.store{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border:1px solid var(--border);border-radius:999px;background:var(--card);color:var(--text);text-decoration:none;font-weight:600;font-size:.98rem}
.store:hover{color:var(--gold2);border-color:var(--gold)}
.store.img{padding:0;border:0;background:none;min-width:0;height:auto}.store.img img{display:block;width:auto}
.related{margin:28px 0 8px}
.related-t{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.related ul{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.related a{display:block;height:100%;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;color:var(--text);text-decoration:none;font-weight:600;font-size:.95rem}
.related a span{display:block;color:var(--muted);font-weight:400;font-size:.85rem;margin-top:2px}.related a:hover{border-color:var(--gold)}
.toc{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin:24px 0}
.toc p{font-weight:700;margin-bottom:6px}.toc ol{padding-left:20px;color:var(--muted);display:grid;gap:4px}.toc a{color:var(--text);text-decoration:none}
h2{font-size:1.45rem;line-height:1.3;margin:44px 0 14px;scroll-margin-top:90px}
h3{font-size:1.08rem;line-height:1.35;margin:24px 0 8px;scroll-margin-top:90px}
p{margin:0 0 14px}
.content ul,.content ol{padding-left:22px;margin:0 0 16px}.content li{margin-bottom:6px}
.muted{color:var(--muted)}strong{color:var(--text)}
.stats{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:18px 0 22px!important;padding:0!important}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 12px;text-align:center;margin:0!important}
.stat b{display:block;font-size:2.2rem;line-height:1.1;font-weight:800;color:var(--gold);letter-spacing:-1px}
.stat span{display:block;color:var(--muted);font-size:.9rem;margin-top:4px}
.table{overflow-x:auto;margin:16px 0 18px;border:1px solid var(--border);border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:.95rem}table.wide{min-width:520px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:top}
th{background:var(--card);font-size:.78rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
tr:last-child td{border-bottom:0}td.pts{font-weight:800;color:var(--gold);white-space:nowrap}
.note{background:var(--card);border-left:3px solid var(--gold);border-radius:0 12px 12px 0;padding:16px 20px;margin:18px 0}
.note.info{border-left-color:var(--brand)}.note p{color:var(--muted)}.note p:last-child{margin:0}
.example{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:14px 0}
.example p:last-child,.example ul:last-child{margin-bottom:0}.example li{color:var(--muted)}
ol.steps{list-style:none;counter-reset:s;display:grid;gap:12px;margin:16px 0!important;padding:0!important}
ol.steps>li{counter-increment:s;position:relative;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px 16px 64px;margin:0}
ol.steps>li::before{content:counter(s);position:absolute;left:18px;top:16px;width:32px;height:32px;border-radius:50%;background:var(--gold);color:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:800}
ol.steps h3{margin:2px 0 4px}ol.steps p{color:var(--muted);margin:0;font-size:.97rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:16px 0 20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px}
.card h3{margin:0 0 6px}.card p{color:var(--muted);font-size:.95rem;margin:0 0 8px}.card p:last-child{margin:0}
ul.facts{list-style:none;padding:0!important}ul.facts li{padding-left:22px;position:relative;color:var(--muted)}
ul.facts li::before{content:"";position:absolute;left:4px;top:.62em;width:8px;height:8px;border-radius:50%;background:var(--gold)}
ol.tips li{color:var(--muted)}ol.tips li strong{display:block;color:var(--text)}
.shots{display:flex;gap:14px;overflow-x:auto;padding:4px 0 12px;margin:16px 0;scroll-snap-type:x mandatory}
.shots figure{flex:0 0 auto;width:min(220px,62vw);scroll-snap-align:start}
.shots img{display:block;width:100%;height:auto;border-radius:18px;border:1px solid var(--border)}
.shots figcaption{color:var(--muted);font-size:.85rem;margin-top:6px;text-align:center}
.in-app{background:linear-gradient(135deg,rgba(245,185,75,.1),rgba(255,107,26,.06));border:1px solid rgba(245,185,75,.35);border-radius:16px;padding:20px 22px;margin:36px 0}
.in-app h2{margin:0 0 10px;font-size:1.25rem}.in-app p:last-child{margin:0}
.cta{text-align:center;margin:32px 0}.cta p{color:var(--muted)}
.faq h3{margin-top:22px}.faq .a p{color:var(--muted)}
.updated{color:var(--muted);font-size:.85rem;margin:36px 0 0}
.reassure{border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--card);margin-top:40px}
.reassure ul{list-style:none;max-width:1080px;margin:0 auto;padding:14px 16px;display:flex;flex-wrap:wrap;justify-content:center;gap:6px 0;font-size:.9rem;color:var(--muted)}
.reassure li+li::before{content:"·";margin:0 10px;color:var(--gold)}
.dl{text-align:center;padding:44px 16px 36px}.dl h2{margin:0 0 6px}.dl p{color:var(--muted)}
.foot{border-top:1px solid var(--border);padding:36px 16px 44px;color:var(--muted);font-size:.9rem}
.foot-in{max-width:1080px;margin:0 auto}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px 16px}
@media(min-width:760px){.cols{grid-template-columns:repeat(4,minmax(0,1fr))}}
.foot-t{color:var(--text);font-weight:700;margin-bottom:8px}.foot ul{list-style:none}.foot li{margin-bottom:6px}
.foot a{color:var(--muted);text-decoration:none}.foot a:hover{color:var(--gold)}
.legal{margin-top:28px;font-size:.8rem;line-height:1.55}.foot-meta{margin-top:10px;font-size:.8rem}
.sticky{position:fixed;left:12px;right:12px;bottom:12px;z-index:25;display:none;align-items:center;justify-content:space-between;gap:12px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:10px 12px 10px 16px;font-size:.92rem}
.sticky.on{display:flex}.sticky .btn-dl{margin:0}
@media(max-width:759px){body:has(.sticky.on){padding-bottom:84px}}
@media(min-width:760px){.sticky.on{display:none}}
.pills{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px!important;padding:0!important}
.pill{border:1px solid var(--border);background:var(--card);border-radius:999px;padding:3px 12px;font-size:.88rem;color:var(--muted);margin:0!important}.pill.on{border-color:var(--gold);color:var(--gold);font-weight:700}
tr.off td{color:var(--muted)}
.histo{margin:16px 0 20px}.histo svg{display:block;width:100%;height:auto}.histo .bar{fill:var(--gold)}.histo .axe{stroke:var(--border)}
.histo text{fill:var(--muted);font-size:19px;text-anchor:middle}.histo .val{fill:var(--text);font-weight:700}.histo figcaption{color:var(--muted);font-size:.85rem;margin-top:8px}
.tonight{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px 20px;margin:24px 0}.tonight h2{margin:0 0 4px;font-size:1.25rem}
.tonight-l{list-style:none;display:grid;gap:6px;margin:12px 0}.tonight-l b{display:inline-block;min-width:4.2em;color:var(--gold)}.tonight p:last-child{margin:0}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;
if (Buffer.byteLength(CSS) > CSS_MAX) err('gabarit', `CSS en ligne de ${Buffer.byteLength(CSS)} octets (max ${CSS_MAX})`);

// Choix du store : iOS → App Store, Android → Google Play, sinon ancre #telecharger. Barre mobile hors iOS.
// Mesure d'audience GoatCounter (sans cookie) : visites + événements clic-store-ios / clic-store-android
// (page d'origine dans le titre de l'événement), sur les liens [data-store] et le bouton [data-dl].
const GC = SITE.goatcounter ? `<script data-goatcounter="${SITE.goatcounter}" async src="https://gc.zgo.at/count.js"></script>` : '';
const JS = `(function(){var u=navigator.userAgent||"",d=document,ios=/iPhone|iPad|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1),an=/Android/i.test(u);d.querySelectorAll("[data-dl]").forEach(function(a){var h=ios?a.getAttribute("data-ios"):an?a.getAttribute("data-android"):null;if(h)a.setAttribute("href",h)});d.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[data-store],a[data-dl]");if(!a||!window.goatcounter||!goatcounter.count)return;var h=a.getAttribute("href")||"",p=a.getAttribute("data-store")||(/apple\.com/.test(h)?"ios":/google\.com/.test(h)?"android":"");if(p)goatcounter.count({path:"clic-store-"+p,title:location.pathname,event:true})});var s=d.getElementById("sticky");if(s&&!ios){var f=function(){var m=d.documentElement;if((m.scrollTop+innerHeight)/m.scrollHeight>.5){s.classList.add("on");removeEventListener("scroll",f)}};addEventListener("scroll",f,{passive:true})}})();`;

// ---------------------------------------------------------------- morceaux de gabarit
function dlButton(c, cls = 'btn-dl') {
  return `<a class="${cls}" href="#telecharger" data-dl data-ios="${escAttr(storeIos(c))}" data-android="${escAttr(storeAndroid(c))}">Télécharger</a>`;
}
function renderMenu(current) {
  const items = [];
  for (const m of SITE.menu || []) {
    if (drafts.has(m.path) || preprod.has(m.path)) { continue; }
    if (!isPublished(m.path)) continue;
    items.push(`<a href="${m.path}"${m.path === current ? ' aria-current="page"' : ''}>${esc(m.label)}</a>`);
  }
  return `<nav class="menu" aria-label="Menu principal">${items.join('')}</nav>`;
}
function renderHeaderBar(current, c) {
  const L = SITE.logo || { src: '/logo-mark.png' };
  const srcs = (L.avif ? `<source type="image/avif" srcset="${L.avif}">` : '') + (L.webp ? `<source type="image/webp" srcset="${L.webp}">` : '');
  const img = `<img src="${L.src}" alt="" width="${L.width || 44}" height="${L.height || 30}" decoding="async">`;
  return `<a class="skip" href="#contenu">Aller au contenu</a>
<header class="bar"><div class="bar-in">
<a class="brand" href="/">${srcs ? `<picture>${srcs}${img}</picture>` : img}<span>Dunk <em>League</em></span></a>
${renderMenu(current)}
${dlButton(c)}
</div></header>`;
}
function renderFooter() {
  const cols = (SITE.footer || []).map((col) => {
    const lis = col.links.map((l) => {
      if (l.url) return `<li><a href="${escAttr(l.url)}" rel="noopener">${esc(l.label)}</a></li>`;
      if (!isPublished(l.path) || preprod.has(l.path)) return '';
      return `<li><a href="${l.path}">${esc(l.label)}</a></li>`;
    }).filter(Boolean);
    if (!lis.length) return '';
    return `<div><p class="foot-t">${esc(col.title)}</p><ul>${lis.join('')}</ul></div>`;
  }).filter(Boolean).join('\n');
  const contact = SITE.contactEmail ? ` · <a href="mailto:${escAttr(SITE.contactEmail)}">Contact</a>` : '';
  return `<footer class="foot"><div class="foot-in">
<div class="cols">
${cols}
</div>
<p class="legal">${esc(SITE.legalLine || '')}</p>
<p class="foot-meta">${esc(SITE.copyright || '')}${contact}</p>
</div></footer>`;
}
function renderReassure() {
  return `<section class="reassure" aria-label="En bref"><ul>${(SITE.reassurance || []).map((r) => `<li>${esc(r).replace(/(\d) %/g, '$1&nbsp;%')}</li>`).join('')}</ul></section>`;
}
function renderDownload(c) {
  return `<section class="dl" id="telecharger" aria-labelledby="telecharger-t"><h2 id="telecharger-t">Télécharge Dunk League</h2><p>Gratuit à jouer sur iPhone et Android, sans argent réel en jeu.</p>${badgesHtml(c)}</section>`;
}
function headHtml({ title, description, canonical, robots, og, jsonld }) {
  const fav = fs.existsSync(path.join(ROOT, 'favicon.ico')) ? '\n<link rel="icon" href="/favicon.ico" sizes="any">' : '';
  const ogLines = og ? `
<meta property="og:type" content="${og.type}">
<meta property="og:site_name" content="${escAttr(SITE.name)}">
<meta property="og:locale" content="${SITE.locale || 'fr_FR'}">
<meta property="og:title" content="${escAttr(og.title)}">
<meta property="og:description" content="${escAttr(og.description)}">
<meta property="og:url" content="${og.url}">
<meta property="og:image" content="${og.image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escAttr(og.imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(og.title)}">
<meta name="twitter:description" content="${escAttr(og.description)}">
<meta name="twitter:image" content="${og.image}">` : '';
  return `<!doctype html>
<html lang="${SITE.lang || 'fr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${escAttr(description)}">${canonical ? `\n<link rel="canonical" href="${canonical}">` : ''}
<meta name="robots" content="${robots}">
<meta name="theme-color" content="${SITE.themeColor || '#0c0e12'}">${fav}
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-itunes-app" content="app-id=${SITE.appleId}">${ogLines}
${GEN_MARK}
<style>${CSS}</style>${jsonld ? `\n<script type="application/ld+json">${jsonld}</script>` : ''}
</head>`;
}

// ---------------------------------------------------------------- JSON-LD
const PAGE_TYPES = new Set(['WebPage', 'ContactPage', 'CollectionPage', 'AboutPage', 'FAQPage', 'ItemPage']);
const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle']);
function orgLogo() {
  const L = SITE.logo || {};
  return { '@type': 'ImageObject', url: BASE + (L.schemaSrc || L.src), width: L.schemaWidth || L.width, height: L.schemaHeight || L.height };
}
// Sur les autres pages : nœuds minimaux pour que author, publisher, isPartOf et about se résolvent dans le document
// (Google ne suit pas un @id vers une autre page). Même @id que sur l'accueil : même entité, pas une seconde.
function minimalEntities(graph) {
  const has = (id) => graph.some((n) => n['@id'] === id && n['@type']);
  const out = [];
  if (!has(ID_ORG)) out.push({ '@type': 'Organization', '@id': ID_ORG, name: SITE.name, url: BASE + '/', logo: orgLogo() });
  if (!has(ID_WEBSITE)) out.push({ '@type': 'WebSite', '@id': ID_WEBSITE, url: BASE + '/', name: SITE.name });
  if (!has(ID_APP) && JSON.stringify(graph).includes(`"${ID_APP}"`)) out.push({ '@type': 'MobileApplication', '@id': ID_APP, name: SITE.name, applicationCategory: 'GameApplication', operatingSystem: 'iOS, Android' });
  return out;
}
// L'éditeur, complet : accueil et page « À propos » (avec le contact). Même @id partout.
function orgEntity({ contact = false } = {}) {
  const o = { '@type': 'Organization', '@id': ID_ORG, name: SITE.name, url: BASE + '/', logo: orgLogo(), sameAs: [SITE.instagram, SITE.appStoreUrl, SITE.playUrl] };
  if (contact && SITE.contactEmail) {
    o.email = SITE.contactEmail;
    o.contactPoint = { '@type': 'ContactPoint', contactType: 'customer support', email: SITE.contactEmail, availableLanguage: 'fr' };
  }
  return o;
}
function homeEntities() {
  return [
    orgEntity(),
    { '@type': 'WebSite', '@id': ID_WEBSITE, url: BASE + '/', name: SITE.name, inLanguage: SITE.inLanguage, publisher: { '@id': ID_ORG } },
    { '@type': 'MobileApplication', '@id': ID_APP, name: SITE.name, applicationCategory: 'GameApplication', operatingSystem: 'iOS, Android', inLanguage: SITE.inLanguage, url: BASE + '/', installUrl: SITE.appStoreUrl, offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }, publisher: { '@id': ID_ORG }, sameAs: [SITE.appStoreUrl, SITE.playUrl] },
  ];
}
function buildGraph(pg, ctx) {
  const url = absUrl(pg.path);
  const graph = [];
  if (pg.path === '/') graph.push(...homeEntities());
  if (ctx.crumbs.length > 1) {
    graph.push({ '@type': 'BreadcrumbList', '@id': url + '#breadcrumb', itemListElement: ctx.crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: absUrl(c.path) })) });
  }
  const list = Array.isArray(pg.meta.schema) ? pg.meta.schema : pg.meta.schema ? [pg.meta.schema] : [];
  // Temps forts : quand la page déclare un SportsEvent, l'Article parle de l'événement (about) et cite l'appli
  // (mentions), pour que l'événement ne reste pas isolé dans le @graph.
  const eventEntry = list.find((e) => e && typeof e === 'object' && [].concat(e['@type']).includes('SportsEvent') && e['@id']);
  const eventId = eventEntry ? eventEntry['@id'] : null;
  // Page « À propos » : l'éditeur est l'entité principale ; le #org complet (sameAs, contact) y est déclaré,
  // avec le même @id que sur l'accueil.
  const isAbout = list.some((e) => [].concat(typeof e === 'string' ? e : e && e['@type']).includes('AboutPage'));
  if (isAbout && pg.path !== '/') graph.push(orgEntity({ contact: true }));
  for (const entry of list) {
    const node = typeof entry === 'string' ? { '@type': entry } : JSON.parse(JSON.stringify(entry));
    const t = node['@type'];
    if (!t && !node['@id']) { err(pg.where, 'entrée schema sans @type ni @id'); continue; }
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => ARTICLE_TYPES.has(x))) {
      const def = { '@id': url + '#article', headline: visibleText(ctx.h1).slice(0, 110), description: ctx.description, inLanguage: SITE.inLanguage, datePublished: pg.meta.publishedOn || pg.meta.modifiedOn, dateModified: pg.meta.modifiedOn, mainEntityOfPage: { '@id': url }, image: ctx.ogImage, author: { '@id': ID_ORG }, publisher: { '@id': ID_ORG }, about: { '@id': eventId || ID_APP } };
      if (eventId) def.mentions = { '@id': ID_APP };
      for (const k in def) if (node[k] === undefined) node[k] = def[k];
      if (node.dateModified !== pg.meta.modifiedOn) err(pg.where, `Article.dateModified (${node.dateModified}) différent de modifiedOn (${pg.meta.modifiedOn})`);
      if (!pg.meta.publishedOn && !pg.meta.noindex) warn(pg.where, 'Article sans publishedOn : datePublished suivrait modifiedOn à chaque actualisation (ajouter "publishedOn", date de la première publication)');
    }
    if (types.some((x) => PAGE_TYPES.has(x))) {
      const def = { '@id': `${url}#${String(types[0]).toLowerCase()}`, url, name: ctx.title, description: ctx.description, inLanguage: SITE.inLanguage, isPartOf: { '@id': ID_WEBSITE }, about: { '@id': ID_APP }, dateModified: ctx.dateModified || pg.meta.modifiedOn };
      if (ctx.crumbs.length > 1) def.breadcrumb = { '@id': url + '#breadcrumb' };
      if (types.includes('AboutPage')) def.mainEntity = { '@id': ID_ORG };
      for (const k in def) if (node[k] === undefined) node[k] = def[k];
    }
    if (types.includes('FAQPage') && !node.mainEntity) {
      node.mainEntity = ctx.faq.map((q) => ({ '@type': 'Question', name: visibleText(q.q), acceptedAnswer: { '@type': 'Answer', text: visibleText(q.a) } }));
    }
    if (types.includes('SportsEvent')) {
      if (node.organizer) err(pg.where, 'SportsEvent : pas d\'organizer (plan, section 6)');
      if (node.offers) err(pg.where, 'SportsEvent : pas d\'offers (plan, section 4.10)');
      if (node.image) warn(pg.where, 'SportsEvent : pas d\'image officielle (plan, section 4.10)');
    }
    if (types.includes('MobileApplication') && node['@id'] !== ID_APP) err(pg.where, `MobileApplication : compléter l'entité existante avec "@id": "${ID_APP}", jamais en déclarer une seconde`);
    if (pg.path !== '/' && (node['@id'] === ID_ORG || node['@id'] === ID_WEBSITE) && node['@type']) err(pg.where, `${node['@id']} n'est déclaré que sur l'accueil`);
    graph.push(node);
  }
  if (pg.path !== '/') graph.push(...minimalEntities(graph));
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph });
  if (/aggregateRating|"review"/i.test(json)) err(pg.where, 'aucune note ni avis dans les données structurées');
  return { graph, json: json.replace(/</g, '\\u003c') };
}

// ---------------------------------------------------------------- rendu d'une page
const NBA_NEAR = /^(officiel|officielle|officiels|officielles|officiellement|partenaire|partenaires|partenariat|partenariats|licence|licences|license|licensed|licencie|licenciee)$/;
function nbaProximity(text) {
  const t = tokenize(text).map((x) => x.n);
  const hits = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'nba') continue;
    for (let j = Math.max(0, i - 5); j <= Math.min(t.length - 1, i + 5); j++) if (NBA_NEAR.test(t[j])) hits.push(t.slice(Math.max(0, i - 5), i + 6).join(' '));
  }
  return hits;
}
const CUR = '[\u0024\u20ac\u00a3\u00a5]';
const SP = '[\\s\u00a0\u202f]*';
const CUR_DUNK = new RegExp(CUR + SP + '\\d*' + SP + 'DUNK|DUNK' + SP + CUR + '|\\d' + SP + CUR + SP + 'DUNK', 'i');
const hasThirdParty = (s) => /\b(mpp|mpg|mon petit prono|mon petit gazon)\b/.test(norm(s));
function imageSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* ignoré */ }
  return null;
}
function crumbsFor(pg) {
  if (pg.path === '/') return [{ name: 'Accueil', path: '/' }];
  if (Array.isArray(pg.meta.breadcrumbs) && pg.meta.breadcrumbs.length) {
    return pg.meta.breadcrumbs.map((b) => ({ name: b.name, path: b.path }));
  }
  const chain = [];
  let cur = pg;
  const seen = new Set();
  while (cur && cur.path !== '/' && !seen.has(cur.path)) {
    seen.add(cur.path);
    chain.unshift({ name: cur.meta ? cur.meta.crumb || visibleText(cur.meta.h1 || '') : labelOf(cur.path), path: cur.path });
    const parent = cur.meta ? cur.meta.parent || defaultParent(cur.path) : defaultParent(cur.path);
    if (parent === '/') break;
    const pp = live.find((x) => x.path === parent);
    cur = pp || (isPublished(parent) ? { path: parent } : null);
    if (!cur) { err(pg.where, `parent ${parent} non publié (fil d'Ariane)`); break; }
  }
  return [{ name: 'Accueil', path: '/' }, ...chain];
}
function defaultParent(p) {
  const segs = p.split('/').filter(Boolean);
  return segs.length <= 1 ? '/' : '/' + segs.slice(0, -1).join('/') + '/';
}
function extractAuto(html) {
  // Blocs automatiques : <!--auto:start--> … <!--auto:end--> (hors empreinte lastmod et hors compte de mots)
  return html.replace(/<!--auto:start-->[\s\S]*?<!--auto:end-->/g, ' ');
}
function addH2Ids(html, used) {
  return html.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi, (all, attrs = '', inner) => {
    const idm = attrs.match(/\sid="([^"]+)"/);
    if (idm) { used.add(idm[1]); return all; }
    let id = slugify(inner);
    let k = 2;
    while (used.has(id)) id = `${slugify(inner)}-${k++}`;
    used.add(id);
    return `<h2${attrs} id="${id}">${inner}</h2>`;
  });
}

function renderPage(pg) {
  const M = pg.meta;
  const W = pg.where;
  if (!M.ctaCampaign) { warn(W, 'ctaCampaign absent : campagne déduite du slug'); M.ctaCampaign = pg.path === '/' ? 'home' : pg.path.split('/').filter(Boolean).join('-'); }
  if (!/^[a-z0-9-]+$/.test(M.ctaCampaign)) err(W, `ctaCampaign « ${M.ctaCampaign} » invalide (minuscules, chiffres, tirets)`);
  for (const f of ['title', 'description', 'h1', 'modifiedOn']) if (!M[f]) err(W, `champ obligatoire « ${f} » manquant`);
  if (M.modifiedOn && !isIsoDate(M.modifiedOn)) err(W, `modifiedOn « ${M.modifiedOn} » n'est pas une date AAAA-MM-JJ`);
  else if (M.modifiedOn > TODAY) err(W, `modifiedOn ${M.modifiedOn} est dans le futur (aujourd'hui ${TODAY})`);
  if (M.publishedOn && (!isIsoDate(M.publishedOn) || M.publishedOn > M.modifiedOn)) err(W, 'publishedOn invalide ou postérieur à modifiedOn');
  if (pg.path !== '/' && !M.crumb) warn(W, 'crumb absent : le fil d\'Ariane reprend le H1');

  const R = (s) => resolveMarkers(s, M, W);
  const title = R(M.title || '');
  const description = R(M.description || '');
  const h1 = R(M.h1 || '');
  const kicker = R(M.kicker || '');
  const intro = R(M.intro || '');
  const heroNote = R(M.heroNote || '');
  const ogTitle = R(M.ogTitle || M.title || '');
  const ogDescription = R(M.ogDescription || M.description || '');
  const faq = (Array.isArray(M.faq) ? M.faq : []).map((q, i) => {
    if (!q || !q.q || !q.a) { err(W, `faq[${i}] sans q ou a`); return null; }
    return { q: R(q.q), a: R(q.a), id: q.id, group: q.group };
  }).filter(Boolean);
  if (M.faq && !Array.isArray(M.faq)) err(W, 'faq doit être une liste');
  if (/<(?!\/?em>|br\s*\/?>)/i.test(h1)) err(W, 'H1 : seules les balises <em> et <br> sont admises');

  if (/<p[^>]*>(?:(?!<\/p>)[\s\S])*\{\{\s*badges\s*\}\}/.test(pg.body)) err(W, '{{badges}} produit un bloc : le placer seul sur sa ligne, hors d\'un <p>');
  if (/\{\{\s*auto:/.test(pg.raw.slice(0, pg.raw.length - pg.body.length))) err(W, 'les marqueurs {{auto:…}} ne s\'emploient que dans le corps, jamais dans l\'en-tête');
  if (M.introPour !== undefined) {
    const moisFr = DONNEES.heureFr(NOW).iso.slice(0, 7);
    const liste = [].concat(M.introPour);
    if (liste.some((x) => !/^\d{4}-\d{2}$/.test(x))) err(W, 'introPour : liste de mois AAAA-MM');
    else if (!liste.includes(moisFr)) warn(W, `intro écrite pour ${liste.join(', ')} : à réécrire pour ${moisFr} (temps fort et contexte du mois), puis mettre à jour introPour et modifiedOn`);
  }
  const resolvedBody = R(expandAuto(pg.body, W));
  let body = resolvedBody;
  body = unwrapDraftLinks(body, W);
  const introHtml = intro ? (/^\s*</.test(intro) ? intro : `<p>${intro}</p>`) : '';
  const usedIds = new Set(['contenu', 'telecharger', 'telecharger-t', 'questions']);
  body = addH2Ids(body, usedIds);

  const indexable = !M.noindex;
  const handContent = [h1, introHtml, extractAuto(body), faq.map((q) => q.q + ' ' + q.a).join(' ')].join(' ');
  const handText = visibleText(handContent);
  const wordCount = words(handText).length;
  const minWords = M.minWords || 400;
  if (indexable && wordCount < minWords) err(W, `page indexable de ${wordCount} mots écrits à la main (minimum ${minWords})`);
  if (!indexable && M.minWords) warn(W, 'minWords ignoré sur une page noindex');

  const crumbs = crumbsFor(pg);
  const url = absUrl(pg.path);
  const ogImagePath = M.ogImage || SITE.defaultOgImage;
  const ogFile = path.join(ROOT, String(ogImagePath).replace(/^\//, ''));
  if (!fs.existsSync(ogFile)) err(W, `ogImage introuvable : ${ogImagePath}`);
  else {
    const sz = imageSize(ogFile);
    if (sz && (sz.w !== 1200 || sz.h !== 630)) warn(W, `ogImage en ${sz.w}×${sz.h}, attendu 1200×630`);
    if (/\.svg$/i.test(ogImagePath)) err(W, 'ogImage en SVG refusée (WhatsApp, Facebook)');
  }
  const ogImage = BASE + ogImagePath;

  // Pages liées
  let relatedHtml = '';
  const related = Array.isArray(M.related) ? M.related : [];
  const relOk = [];
  for (const r of related) {
    if (drafts.has(r)) { warn(W, `page liée ${r} en brouillon : retirée du bloc`); continue; }
    if (preprod.has(r)) { warn(W, `page liée ${r} en préproduction : retirée du bloc`); continue; }
    if (!isPublished(r)) { err(W, `page liée ${r} inexistante`); continue; }
    if (r === pg.path) { err(W, 'la page se cite elle-même dans related'); continue; }
    relOk.push(r);
  }
  if (indexable && (relOk.length < 4 || relOk.length > 6)) warn(W, `${relOk.length} page(s) liée(s) publiée(s), le plan en demande 4 à 6`);
  if (relOk.length) {
    relatedHtml = `<nav class="related" aria-label="Pages liées"><p class="related-t">Pages liées</p><ul>${relOk.map((r) => {
      const t = live.find((x) => x.path === r);
      const label = t ? R(t.meta.relatedLabel || t.meta.crumb || (r === '/' ? 'Accueil' : visibleText(t.meta.h1))) : labelOf(r);
      const blurb = t && t.meta.relatedBlurb ? `<span>${esc(R(t.meta.relatedBlurb))}</span>` : '';
      return `<li><a href="${r}">${esc(label)}${blurb}</a></li>`;
    }).join('')}</ul></nav>`;
  }

  // Sommaire
  let tocHtml = '';
  const tocMode = M.toc === undefined ? 'auto' : M.toc;
  if (tocMode === true || (tocMode === 'auto' && wordCount > 1200)) {
    const h2s = [...body.matchAll(/<h2[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => ({ id: m[1], t: visibleText(m[2]) }));
    if (h2s.length >= 2) tocHtml = `<nav class="toc" aria-label="Sommaire"><p>Au programme</p><ol>${h2s.map((h) => `<li><a href="#${h.id}">${esc(h.t)}</a></li>`).join('')}</ol></nav>`;
  }

  // FAQ
  let faqHtml = '';
  if (faq.length) {
    const groups = [];
    for (const q of faq) {
      const g = q.group || '';
      let G = groups.find((x) => x.name === g);
      if (!G) groups.push((G = { name: g, items: [] }));
      G.items.push(q);
    }
    const hasGroups = groups.some((g) => g.name);
    const qa = (q) => {
      let id = q.id || 'q-' + cutSlug(slugify(q.q), 50);
      if (usedIds.has(id)) id += '-2';
      usedIds.add(id);
      q.id = id;
      return `<div class="qa"><h3 id="${id}">${esc(visibleText(q.q))}</h3><div class="a">${/^\s*</.test(q.a) ? q.a : `<p>${q.a}</p>`}</div></div>`;
    };
    if (hasGroups) {
      faqHtml = `<section class="faq">${groups.map((g) => {
        let gid = g.name ? slugify(g.name) : 'questions';
        while (g.name && usedIds.has(gid)) gid += '-2';
        usedIds.add(gid);
        return `<h2 id="${gid}">${esc(g.name || M.faqTitle || 'Questions')}</h2>${g.items.map(qa).join('')}`;
      }).join('')}</section>`;
    } else {
      faqHtml = `<section class="faq" aria-labelledby="questions"><h2 id="questions">${esc(M.faqTitle || 'Questions')}</h2>${faq.map(qa).join('')}</section>`;
    }
  }

  // Page dont le contenu suit les données (/ce-soir/, "dateFromData": true) : la date visible « Actualisé le »
  // et WebPage.dateModified sont celles de l'instantané, jamais une date figée (plan, 5.3.6). Le sitemap garde
  // modifiedOn (empreinte du texte écrit à la main).
  const dataDate = M.dateFromData && SNAP ? SNAP.generated_at : null;
  const ctx = { title, description, h1, faq, crumbs, ogImage, dateModified: dataDate };
  const { graph, json } = buildGraph(pg, ctx);
  const updatedHtml = dataDate
    ? `<p class="updated">Actualisé le <time datetime="${escAttr(dataDate)}">${dateShort(DONNEES.heureFr(dataDate).iso)}</time></p>`
    : `<p class="updated">Actualisé le <time datetime="${M.modifiedOn}">${isIsoDate(M.modifiedOn) ? dateShort(M.modifiedOn) : ''}</time></p>`;

  const crumbsHtml = pg.path === '/' ? '' : `<nav class="crumbs" aria-label="Fil d'Ariane"><ol>${crumbs.map((c, i) => (i === crumbs.length - 1 ? `<li aria-current="page">${esc(c.name)}</li>` : `<li><a href="${c.path}">${esc(c.name)}</a></li>`)).join('')}</ol></nav>`;
  const heroBadges = M.heroBadges === false ? '' : badgesHtml(M.ctaCampaign);
  const sticky = M.stickyCta ? `<div class="sticky" id="sticky"><span>Tes pronos de la nuit, gratuitement</span>${dlButton(M.ctaCampaign)}</div>` : '';
  const disclaimer = M.disclaimerTop ? `<p class="disclaimer">${esc(SITE.disclaimerShort || '')}</p>` : '';
  // Encart « Cette nuit » de l'accueil (plan, 7, vague 2), activé par site.json "homeTonight". Hors empreinte lastmod.
  let tonightHtml = '';
  if (pg.path === '/' && SITE.homeTonight === true) {
    const lien = isPublished('/ce-soir/') && !preprod.has('/ce-soir/') ? '/ce-soir/' : null;
    if (!lien) warn(W, 'homeTonight activé alors que /ce-soir/ est en préproduction ou absente : encart sans lien vers le programme complet');
    tonightHtml = DONNEES.blocCetteNuit(autoCtx(), { lien, nb: DONNEES_CONF.accueilNbMatchs || 3 });
  }

  const html = `${headHtml({
    title, description, canonical: url,
    robots: indexable ? 'index,follow,max-image-preview:large' : 'noindex,follow',
    og: { type: M.ogType || (pg.path === '/' ? 'website' : 'article'), title: ogTitle, description: ogDescription, url, image: ogImage, imageAlt: R(M.ogImageAlt || 'Dunk League, pronos basket entre potes') },
    jsonld: json,
  })}
<body>
${renderHeaderBar(pg.path, M.ctaCampaign)}
<main id="contenu">
<div class="wrap">
${crumbsHtml}
<header class="hero">
${kicker ? `<p class="kicker">${esc(visibleText(kicker))}</p>\n` : ''}<h1>${h1}</h1>
${disclaimer}${heroNote ? `<p class="hero-note">${heroNote}</p>` : ''}${introHtml ? `<div class="intro">${introHtml}</div>` : ''}
${heroBadges}${M.heroMedia ? `<div class="hero-media">${R(M.heroMedia)}</div>` : ''}
</header>
${tonightHtml}${relatedHtml}
${tocHtml}
<article class="content">
${stripComments(body).trim()}
</article>
${faqHtml}
${updatedHtml}
</div>
${renderReassure()}
${renderDownload(M.ctaCampaign)}
</main>
${renderFooter()}
${sticky}<script>${JS}</script>${GC ? `
${GC}` : ''}
</body>
</html>
`;
  const bodyVisible = visibleText([introHtml, heroNote, stripComments(body), faqHtml].join(' '));
  const fingerprint = sha(JSON.stringify([title, description, h1, kicker, intro, extractAuto(resolvedBody), faq.map((q) => [q.q, q.a])]));
  return { pg, html, title, description, h1, ogTitle, ogDescription, faq, indexable, wordCount, handText, bodyVisible, graph, fingerprint, body };
}

function render404() {
  const c = '404';
  const links = ((SITE.page404 && SITE.page404.links) || ['/']).filter((p) => isPublished(p) && !preprod.has(p)).map((p) => `<li><a href="${p}">${esc(p === '/' ? 'Accueil' : labelOf(p))}</a></li>`).join('');
  const title = 'Page introuvable — Dunk League';
  const description = 'Cette page n\'existe pas ou a changé d\'adresse. Retrouve le jeu de pronos basket Dunk League depuis l\'accueil.';
  return `${headHtml({ title, description, canonical: null, robots: 'noindex,follow', og: null, jsonld: null })}
<body>
${renderHeaderBar('', c)}
<main id="contenu">
<div class="wrap">
<header class="hero">
<p class="kicker">Erreur 404</p>
<h1>Cette page <em>n'existe pas</em></h1>
<div class="intro"><p>L'adresse a peut-être changé, ou il manque un bout du lien. Voici les pages les plus utiles.</p></div>
</header>
<article class="content"><ul>${links}</ul></article>
</div>
${renderReassure()}
${renderDownload(c)}
</main>
${renderFooter()}
<script>${JS}</script>${GC ? `
${GC}` : ''}
</body>
</html>
`;
}

// ---------------------------------------------------------------- rendu
if (!pages.length) warn('_src/pages', 'aucune page source : seuls sitemap.xml et 404.html sont produits');
const outs = live.map(renderPage);
const page404 = render404();

// ---------------------------------------------------------------- contrôles transverses
const byPath = new Map(outs.map((o) => [o.pg.path, o]));
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const legacyTitles = new Map([...legacyServed].map(([p, h]) => [p, decode((h.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()]));
const anchorUse = new Map();
const faqSeen = new Map();
const legacyQuestions = new Map();
for (const [p, h] of legacyServed) {
  for (const m of h.matchAll(/<(summary|h3)[^>]*>([\s\S]*?)<\/\1>/gi)) legacyQuestions.set(norm(visibleText(m[2])), p);
}
const queriesOf = (o) => [].concat(o.pg.meta.primaryQuery || []).map(norm).filter((q) => q && q !== norm(SITE.name));
const containsPhrase = (hay, needle) => (' ' + norm(hay) + ' ').includes(' ' + needle + ' ');

for (const o of outs) {
  const W = o.pg.where;
  const M = o.pg.meta;
  // Longueurs
  if (countChars(o.title) > 60) err(W, `title de ${countChars(o.title)} caractères (max 60) : « ${o.title} »`);
  if (countChars(o.description) > 155) err(W, `meta description de ${countChars(o.description)} caractères (max 155)`);
  if (countChars(o.description) < 70) warn(W, `meta description courte (${countChars(o.description)} caractères)`);
  if (countChars(o.ogTitle) > 90) warn(W, 'og:title long (plus de 90 caractères)');
  // H1
  const h1n = (o.html.match(/<h1[\s>]/gi) || []).length;
  if (h1n !== 1) err(W, `${h1n} H1 dans la page (exactement 1 attendu ; le H1 vient de l'en-tête, jamais du corps)`);
  if (!/<link rel="canonical" href="https:\/\/dunkleague\.app\/[^"]*\/?">/.test(o.html)) err(W, 'canonical absent ou non absolu');
  // Titres en double
  for (const x of outs) if (x !== o && x.title === o.title && x.pg.path < o.pg.path) err(W, `title identique à ${x.pg.path}`);
  for (const [p, t] of legacyTitles) if (t && t === o.title) warn(W, `title identique à la page à la main ${p}`);
  // Requêtes principales (tableau 2 bis)
  for (const x of outs) {
    if (x === o) continue;
    for (const q of queriesOf(x)) {
      if (containsPhrase(o.title, q)) err(W, `title contient « ${q} », requête principale de ${x.pg.path}`);
      if (containsPhrase(visibleText(o.h1), q)) err(W, `H1 contient « ${q} », requête principale de ${x.pg.path}`);
    }
  }
  for (const f of [].concat(M.forbiddenInTitle || [])) {
    const q = norm(f);
    if (containsPhrase(o.title, q)) err(W, `title contient « ${f} », interdit pour cette page (forbiddenInTitle)`);
    if (containsPhrase(visibleText(o.h1), q)) err(W, `H1 contient « ${f} », interdit pour cette page (forbiddenInTitle)`);
  }
  // Marques tierces
  if (hasThirdParty(visibleText(o.h1))) err(W, 'MPP, MPG ou Mon Petit Prono/Gazon dans le H1');
  if (hasThirdParty(o.ogTitle)) err(W, 'MPP, MPG ou Mon Petit Prono/Gazon dans l\'og:title (renseigne ogTitle sans la marque)');
  if (/\b(mpp|mpg)\b/.test(o.pg.path.replace(/-/g, ' ')) && !(EXC.slugsMarqueTierce || {})[o.pg.path]) err(W, 'MPP ou MPG dans le slug');
  const nb = norm(o.bodyVisible + ' ' + o.title + ' ' + o.description + ' ' + o.ogTitle + ' ' + visibleText(o.h1));
  if (/\b(le|un|ton|notre|son|ce) (mpp|mon petit prono) (du|de|pour|version) /.test(nb + ' ') || /\bcomme (mpp|mon petit prono) mais\b/.test(nb)) err(W, 'formule qui présente Dunk League comme « le MPP » d\'un sport (plan, 6 bis)');
  // NBA
  const nbaZone = [o.title, o.description, o.ogTitle, o.ogDescription, visibleText(o.h1), o.bodyVisible].join(' . ');
  for (const h of new Set(nbaProximity(nbaZone))) err(W, `« officiel / partenaire / licence » à moins de 5 mots de NBA : « ${h} »`);
  const headZone = norm([o.title, o.ogTitle, visibleText(o.h1)].join(' . '));
  if (/\bleague pass\b/.test(headZone)) err(W, '« League Pass » dans le title, le H1 ou l\'og:title (plan, 6 bis)');
  if (/\bnba all star\b/.test(headZone)) err(W, '« NBA All-Star » en nom de page : écrire « le All-Star Game 2027 » (plan, 6 bis)');
  // Dans le corps, « l'application NBA » peut désigner l'appli de la ligue (guide pour regarder les matchs) : contrôle limité aux titres.
  if (/\b(appli|application|jeu) nba\b|\bpronos? officiel/.test(norm([o.title, o.ogTitle, o.description, visibleText(o.h1)].join(' . ')))) err(W, '« appli NBA », « jeu NBA » ou « pronos officiels » dans title, H1, og:title ou meta : écrire « l\'appli de pronos basket » (plan, 6 bis)');
  if (/\bpronos? officiel/.test(norm(o.bodyVisible))) err(W, '« pronos officiels » : aucun lien suggéré avec la ligue (plan, 6 bis)');
  if ((o.body.match(/<h2[^>]*>[^<]*League Pass/gi) || []).length > 1) warn(W, '« League Pass » dans plus d\'un H2');
  // DUNK
  const vis = visibleText(o.html);
  if (CUR_DUNK.test(vis)) err(W, 'symbole monétaire collé à DUNK');
  if (/\u0024/.test(vis)) warn(W, 'caractère « $ » dans le texte visible');
  if (/\b(gagne|gagnes|gagner|gagnez|remporte|remportes|remporter|empoche|empoches)\b(\s+\S+){0,3}\s+dunk\b/.test(norm(o.bodyVisible + ' ' + visibleText(o.h1)))) warn(W, 'DUNK présentés comme un gain : écrire « débloque des cosmétiques » (un prono donne des points)');
  if (o.pg.path !== '/') for (const m of o.html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)) if (/^c est quoi dunk league$/.test(norm(visibleText(m[1])))) err(W, 'le H2 « C\'est quoi, Dunk League ? » n\'existe que sur l\'accueil');
  // Restes
  if (/\bTODO\b/.test(stripComments(o.html))) err(W, 'TODO visible dans la page publiée (le laisser dans un commentaire de source)');
  if (/\{\{/.test(o.html)) err(W, 'marqueur {{…}} non résolu');
  // JSON-LD dans le corps
  for (const m of o.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch (e) { err(W, `JSON-LD invalide (${e.message})`); }
  }
  if ((o.html.match(/application\/ld\+json/g) || []).length > 1) warn(W, 'JSON-LD en plus du @graph du gabarit : préfère le champ schema');
  // Titres
  const heads = [...o.body.matchAll(/<h([23])[\s>]/gi)].map((m) => m[1]);
  if (heads[0] === '3') warn(W, 'un H3 apparaît avant tout H2 dans le corps');
  // Liens et images
  const pageIds = ids(o.html);
  for (const m of o.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const hrefM = attrs.match(/\shref="([^"]*)"/);
    if (!hrefM) { if (/\shref='/.test(attrs)) err(W, 'href entre apostrophes : utiliser des guillemets'); continue; }
    let href = decode(hrefM[1]);
    if (/target="_blank"/.test(attrs) && !/rel="[^"]*noopener/.test(attrs)) warn(W, `target=_blank sans rel=noopener (${href})`);
    if (/^(mailto:|tel:)/.test(href)) continue;
    if (/^https?:\/\//.test(href) && !href.startsWith(BASE)) continue;
    if (href.startsWith(BASE)) { warn(W, `lien absolu interne ${href} : écrire le chemin seul`); href = href.slice(BASE.length) || '/'; }
    if (href.startsWith('#')) { if (href.length > 1 && !pageIds.has(href.slice(1))) warn(W, `ancre ${href} absente de la page`); continue; }
    if (!href.startsWith('/') || href.startsWith('//')) { err(W, `lien relatif « ${href} » : écrire un chemin depuis la racine`); continue; }
    const [pathPart, hash] = href.split('#');
    const target = pathPart.split('?')[0];
    const last = target.split('/').pop();
    if (last.includes('.')) { if (!fs.existsSync(path.join(ROOT, target.slice(1)))) err(W, `lien vers un fichier absent ${target}`); continue; }
    if (!target.endsWith('/')) { err(W, `lien interne sans barre finale ${target}`); continue; }
    if (drafts.has(target)) { err(W, `lien vers la page brouillon ${target}`); continue; }
    if (preprod.has(target) && target !== o.pg.path) { err(W, `lien vers la page en préproduction ${target}`); continue; }
    if (!isPublished(target)) { err(W, `lien interne cassé ${target}`); continue; }
    if (hash && byPath.has(target) && !ids(byPath.get(target).html).has(hash)) warn(W, `ancre #${hash} absente de ${target}`);
  }
  // Ancres du corps et des réponses de FAQ (plan, 2 : jamais la même ancre exacte plus de deux fois sur le site)
  for (const m of (o.body + ' ' + o.faq.map((q) => q.a).join(' ')).matchAll(/<a\b[^>]*href="(\/[^"#?]*)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const k = norm(visibleText(m[2]));
    if (!k) continue;
    const e = anchorUse.get(k) || [];
    e.push(o.pg.path);
    anchorUse.set(k, e);
  }
  for (const m of o.html.matchAll(/<img\b([^>]*)>/gi)) {
    const a = m[1];
    const src = (a.match(/\ssrc="([^"]*)"/) || [])[1];
    if (!/\salt="/.test(a)) err(W, `image sans alt (${src})`);
    const isBadge = src && Object.values(SITE.badges || {}).includes(src);
    if (!isBadge && !(/\swidth="/.test(a) && /\sheight="/.test(a))) warn(W, `image sans width et height (${src}) : risque de décalage à l'affichage`);
    if (src && src.startsWith('/') && !fs.existsSync(path.join(ROOT, src.slice(1).split('?')[0]))) err(W, `image absente ${src}`);
  }
  // FAQ en double
  for (const q of o.faq) {
    const k = norm(visibleText(q.q));
    if (faqSeen.has(k)) err(W, `question de FAQ déjà posée sur ${faqSeen.get(k)} : « ${visibleText(q.q)} »`);
    else faqSeen.set(k, o.pg.path);
    if (legacyQuestions.has(k)) warn(W, `question de FAQ aussi présente sur la page à la main ${legacyQuestions.get(k)}`);
  }
  // Intro
  if (M.intro && !/<strong>/.test(M.intro) && o.indexable) warn(W, 'intro sans <strong> autour de la requête principale');
  if (!M.primaryQuery && o.indexable) warn(W, 'primaryQuery absente');
  // Menu
  const inSiteMenu = (SITE.menu || []).some((m) => m.path === o.pg.path);
  if (M.inMenu !== undefined && Boolean(M.inMenu) !== inSiteMenu && !preprod.has(o.pg.path)) warn(W, `inMenu=${M.inMenu} mais le menu de _config/site.json ${inSiteMenu ? 'contient' : 'ne contient pas'} cette page`);
  // Lexique
  reportLexique(W + ' (sortie)', decode(o.html), o.bodyVisible, o.pg.path);
}
for (const [k, list] of anchorUse) if (list.length > 2) warn('ancres', `texte de lien « ${k} » utilisé ${list.length} fois (${[...new Set(list)].join(', ')}) : varier les ancres`);

// FAQPage unique
const faqPages = outs.filter((o) => o.graph.some((n) => [].concat(n['@type']).includes('FAQPage')));
if (faqPages.length > 1) err('FAQPage', `déclarée sur ${faqPages.map((o) => o.pg.path).join(', ')} : une seule page (/questions/)`);
for (const o of faqPages) if (!o.faq.length) err(o.pg.where, 'FAQPage sans faq dans l\'en-tête');
if (outs.length && !byPath.has('/') && outs.some((o) => /#app"/.test(o.html))) warn('JSON-LD', `#app est référencé mais l'accueil n'est pas encore généré : l'entité n'est déclarée nulle part`);

// Similarité (Jaccard sur des suites de 5 mots) entre pages d'un même gabarit
const shingles = (text) => {
  const w = norm(text).split(' ');
  const s = new Set();
  for (let i = 0; i + 5 <= w.length; i++) s.add(w.slice(i, i + 5).join(' '));
  return s;
};
const sh = outs.filter((o) => o.indexable).map((o) => ({ o, s: shingles(o.handText), g: o.pg.meta.gabarit || 'page' }));
for (let i = 0; i < sh.length; i++) for (let j = i + 1; j < sh.length; j++) {
  if (sh[i].g !== sh[j].g || !sh[i].s.size || !sh[j].s.size) continue;
  let inter = 0;
  for (const x of sh[i].s) if (sh[j].s.has(x)) inter++;
  const jac = inter / (sh[i].s.size + sh[j].s.size - inter);
  if (jac > 0.4) err(sh[i].o.pg.where, `contenu similaire à ${Math.round(jac * 100)} % avec ${sh[j].o.pg.path} (gabarit ${sh[i].g}, max 40 %)`);
}

// Écrasement d'une page à la main
for (const o of outs) {
  const p = o.pg.path;
  if (handOnDisk.has(p) && !o.pg.meta.replacesLegacy) err(o.pg.where, `${outFileFor(p)} est une page écrite à la main : ajoute "replacesLegacy": true pour la remplacer`);
}

// Menu
for (const m of SITE.menu || []) {
  if (!isPublished(m.path)) warn('menu', `${m.path} non publiée : absente du menu`);
  else if (preprod.has(m.path)) warn('menu', `${m.path} en préproduction : absente du menu, du pied de page et du sitemap (retirer "preprod" pour l'ouvrir)`);
}

// Lexique des sources, de la config, des scripts et des fichiers texte publiés
const SCAN_EXT = /\.(html|md|json|txt|xml|mjs|js|css|yml|yaml)$/i;
const scanDirs = [SRC_DIR, CONFIG_DIR, path.join(ROOT, '_scripts'), path.join(ROOT, '.github')];
for (const f of scanDirs.flatMap((d) => walk(d)).filter((f) => SCAN_EXT.test(f))) {
  if (path.basename(f) === 'lexique.json' || f === STATE_FILE) continue;
  const raw = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let bodyText = null;
  let pagePath = null;
  if (f.startsWith(PAGES_DIR) && f.endsWith('.html')) {
    pagePath = pathFromFile(f);
    const hm = raw.match(/^\s*<!--meta\s*[\s\S]*?-->/);
    bodyText = visibleText(hm ? raw.slice(hm[0].length) : raw);
  }
  reportLexique(rel + ' (source)', decode(raw), bodyText, pagePath);
}
for (const name of fs.readdirSync(ROOT)) {
  const f = path.join(ROOT, name);
  if (!fs.statSync(f).isFile() || !SCAN_EXT.test(name) || name === 'index.html' || name === '404.html' || name === 'sitemap.xml') continue;
  reportLexique(name, decode(fs.readFileSync(f, 'utf8')), null, null);
}
reportLexique('404.html (sortie)', decode(page404), null, '/404.html');

// robots.txt
const robotsTxt = fs.existsSync(path.join(ROOT, 'robots.txt')) ? fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8') : '';
for (const need of ['Allow: /', 'Disallow: /_src/', 'Disallow: /_config/', 'Disallow: /_scripts/', 'Disallow: /_data/', `Sitemap: ${BASE}/sitemap.xml`]) {
  if (!robotsTxt.includes(need)) warn('robots.txt', `ligne manquante « ${need} »`);
}
for (const p of [...LEGACY.values()].filter((l) => !l.indexable).map((l) => l.path)) if (new RegExp(`Disallow:\\s*${p}\\s*$`, 'm').test(robotsTxt)) err('robots.txt', `${p} ne doit jamais être bloquée (noindex suffit)`);

// Empreintes : lastmod honnête
const prevState = fs.existsSync(STATE_FILE) ? readJson(STATE_FILE) || {} : {};
const nextState = {};
for (const o of outs) {
  const p = o.pg.path;
  nextState[p] = { empreinte: o.fingerprint, modifiedOn: o.pg.meta.modifiedOn };
  const prev = prevState[p];
  if (!prev) continue;
  if (prev.empreinte !== o.fingerprint && prev.modifiedOn === o.pg.meta.modifiedOn) warn(o.pg.where, `contenu modifié sans changer modifiedOn (${o.pg.meta.modifiedOn})`);
  if (prev.empreinte === o.fingerprint && prev.modifiedOn !== o.pg.meta.modifiedOn) warn(o.pg.where, `modifiedOn changé sans changement de contenu : fausse fraîcheur`);
}

// Pages générées orphelines
const orphans = [...generatedOnDisk].filter((p) => !livePaths.has(p));
for (const p of orphans) warn('orphelin', `${outFileFor(p)} a été généré mais n'a plus de source publiée${FLAG('--prune') ? ' : supprimé' : ' (relance avec --prune pour le supprimer)'}`);

// TODO-VERIFIER restants
let todoCount = 0;
for (const pg of pages) todoCount += (pg.raw.match(/TODO-VERIFIER/g) || []).length;
if (todoCount) warn('sources', `${todoCount} TODO-VERIFIER dans les sources (non publiés, à lever avant de retirer draft)`);

// ---------------------------------------------------------------- sitemap
const smEntries = [];
for (const o of outs) if (o.indexable) smEntries.push({ loc: absUrl(o.pg.path), lastmod: o.pg.meta.modifiedOn });
for (const [p] of legacyServed) {
  const conf = LEGACY.get(p);
  if (conf && conf.indexable) smEntries.push({ loc: absUrl(p), lastmod: conf.lastmod });
}
smEntries.sort((a, b) => (a.loc === BASE + '/' ? -1 : b.loc === BASE + '/' ? 1 : a.loc.localeCompare(b.loc)));
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${smEntries.map((e) => `  <url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;

// ---------------------------------------------------------------- sortie
const line = '─'.repeat(60);
if (warnings.length) {
  console.log(`\n${line}\nAVERTISSEMENTS (${warnings.length})\n${line}`);
  for (const w of warnings) console.log('  ! ' + w);
}
if (errors.length) {
  console.log(`\n${line}\nERREURS (${errors.length}) : rien n'a été écrit\n${line}`);
  for (const e of errors) console.log('  ✗ ' + e);
  console.log('');
  process.exit(1);
}
const written = [];
// En aperçu (données fictives ou de test), tout part dans _preview/ : rien ne touche la racine servie.
const OUT_ROOT = DATA_MODE === 'apercu' ? path.join(ROOT, '_preview') : ROOT;
const writeIfChanged = (rel, content) => {
  const f = path.join(OUT_ROOT, rel);
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === content) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  written.push(path.relative(ROOT, f).replace(/\\/g, '/'));
};
if (!FLAG('--check')) {
  for (const o of outs) writeIfChanged(outFileFor(o.pg.path), o.html);
  writeIfChanged('404.html', page404);
  writeIfChanged('sitemap.xml', sitemap);
  if (DATA_MODE !== 'apercu') {
    if (JSON.stringify(prevState) !== JSON.stringify(nextState)) writeIfChanged(path.relative(ROOT, STATE_FILE), JSON.stringify(nextState, null, 2) + '\n');
    if (FLAG('--prune')) for (const p of orphans) { fs.rmSync(path.join(ROOT, outFileFor(p))); written.push(outFileFor(p) + ' (supprimé)'); }
  }
}
console.log(`\n${line}\nOK : ${outs.length} page(s) générée(s), ${draftSources.length} brouillon(s), ${preprod.size} en préproduction, ${legacyServed.size} page(s) à la main conservée(s), ${smEntries.length} URL dans le sitemap, ${warnings.length} avertissement(s).`);
console.log(`Données : ${DATA_MODE === 'live' ? `réelles (${DATA_FILE}, générées le ${SNAP.generated_at})` : DATA_MODE === 'apercu' ? `APERÇU ${DATA_FILE} → _preview/` : 'aucune, blocs de repli'}.`);
if (FLAG('--check')) console.log('Mode --check : aucun fichier écrit.');
else console.log(written.length ? 'Écrits : ' + written.join(', ') : 'Aucun fichier modifié.');
console.log('');
