#!/usr/bin/env node
// Télécharge l'instantané des données de l'app (table public.site_snapshot de Supabase) et
// l'écrit dans _data/snapshot.json. Node 20+, aucune dépendance.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<clé anon> node _scripts/fetch-snapshot.mjs
//
// Lecture seule, avec la clé anon (publique, déjà dans l'app) : une policy select unique ouvre
// cette seule ligne au rôle anon. Le payload ne contient que des agrégats (voir README.md,
// section « Données de l'app »).
//
// Ne fait jamais échouer le pipeline : en cas d'échec réseau, de variable manquante ou de
// forme invalide, le _data/snapshot.json existant est gardé tel quel, un avertissement est
// affiché et le script sort en code 0. Le build se rabat alors sur les dernières données
// valides, ou sur ses blocs de repli : jamais de page vide, jamais de données inventées.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validerSnapshot } from './donnees.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_data', 'snapshot.json');
const TIMEOUT_MS = 20000;
const ESSAIS = 3;

const avert = (m) => {
  console.log(`! fetch-snapshot : ${m}`);
  // Annotation visible dans le résumé de GitHub Actions.
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Données de l'app::${m.replace(/\r?\n/g, ' ')}`);
};
function garderExistant(raison) {
  avert(raison);
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      avert(`instantané précédent conservé (généré le ${prev.generated_at || 'date inconnue'})`);
    } catch {
      avert('instantané précédent conservé, mais illisible : le build utilisera ses blocs de repli');
    }
  } else {
    avert('aucun instantané précédent : le build utilisera ses blocs de repli (chiffres figés vérifiés, /ce-soir/ sans programme)');
  }
  process.exit(0);
}

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!url || !key) garderExistant('SUPABASE_URL ou SUPABASE_ANON_KEY absent de l\'environnement (secrets du dépôt à créer)');
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) garderExistant('SUPABASE_URL ne ressemble pas à https://<ref>.supabase.co');

const endpoint = `${url}/rest/v1/site_snapshot?id=eq.1&select=generated_at,payload`;

async function telecharger() {
  let derniere = '';
  for (let i = 1; i <= ESSAIS; i++) {
    try {
      const res = await fetch(endpoint, {
        headers: { apikey: key, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // Le corps d'erreur de l'API n'est jamais affiché en entier (il pourrait reprendre la requête).
        derniere = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } else {
        return await res.json();
      }
    } catch (e) {
      derniere = e && e.name === 'TimeoutError' ? `délai de ${TIMEOUT_MS / 1000} s dépassé` : `erreur réseau (${(e && e.message) || e})`;
    }
    if (i < ESSAIS) await new Promise((r) => setTimeout(r, 2000 * i));
  }
  throw new Error(derniere || 'échec inconnu');
}

let rows;
try {
  rows = await telecharger();
} catch (e) {
  garderExistant(`téléchargement impossible : ${e.message}`);
}
if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') {
  garderExistant(`réponse inattendue (${Array.isArray(rows) ? rows.length + ' ligne(s)' : typeof rows}) : la table site_snapshot doit contenir exactement la ligne id = 1, lisible par anon`);
}
const row = rows[0];
const payload = row.payload;
if (payload && typeof payload === 'object' && !payload.generated_at && row.generated_at) payload.generated_at = row.generated_at;

const problemes = validerSnapshot(payload);
if (problemes.length) {
  garderExistant(`forme invalide, instantané refusé :\n  - ${problemes.slice(0, 15).join('\n  - ')}${problemes.length > 15 ? `\n  - … et ${problemes.length - 15} autre(s)` : ''}`);
}

// Ne jamais remplacer un instantané par un plus ancien (réplica en retard, cache).
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (prev.generated_at && Date.parse(prev.generated_at) > Date.parse(payload.generated_at)) {
      garderExistant(`instantané reçu (${payload.generated_at}) plus ancien que celui déjà présent (${prev.generated_at})`);
    }
  } catch { /* fichier précédent illisible : on le remplace */ }
}

const ageH = (Date.now() - Date.parse(payload.generated_at)) / 3600e3;
if (ageH > 36) avert(`instantané généré il y a ${Math.round(ageH)} h : la table site_snapshot n'est plus actualisée par le serveur ?`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT + '.tmp', JSON.stringify(payload, null, 2) + '\n');
fs.renameSync(OUT + '.tmp', OUT);
const nuits = payload.nights.length;
const matchs = payload.nights.reduce((s, n) => s + n.games.length, 0);
console.log(`fetch-snapshot : _data/snapshot.json écrit (généré le ${payload.generated_at}, ${nuits} nuit(s), ${matchs} match(s), ${payload.community.length} bilan(s) de la communauté).`);
