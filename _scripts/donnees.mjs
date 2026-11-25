// Données de l'app pour les blocs automatiques du site (vague 2). Node 20+ (la CI tourne sous Node 24), aucune dépendance.
//
// Contrat : table public.site_snapshot de Supabase, une seule ligne, payload version 1.
// Lu par _scripts/fetch-snapshot.mjs (validation, écriture de _data/snapshot.json) et par
// _scripts/build.mjs (marqueurs {{auto:…}}). Voir README.md, section « Données de l'app ».
//
// Règles de publication (plan, 5.2) : aucun prono maison, aucune tendance avant un match, aucune
// stat par équipe, aucune donnée personnelle. Les chiffres des joueurs ne concernent que des
// matchs terminés, au-dessus du seuil, en pourcentages arrondis à 5.

export const STATUTS = new Set(['scheduled', 'live', 'final', 'postponed', 'canceled']);
export const STAGES = new Set(['regular', 'playoffs', 'other']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isIsoTs = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !isNaN(Date.parse(s));
const isInt = (n) => Number.isInteger(n);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

// La répartition horaire des coups d'envoi : le contrat nomme sa clé « tipoff_ » suivi du nom de la
// ville qui donne l'heure française. Ce nom est au lexique : on ne l'écrit pas, on retrouve la clé
// par son préfixe. Une clé « tipoff_fr » est acceptée aussi (c'est celle du fichier d'exemple).
export function cleRepartition(season) {
  if (!isObj(season)) return null;
  if (Array.isArray(season.tipoff_fr)) return 'tipoff_fr';
  return Object.keys(season).find((k) => k.startsWith('tipoff_') && Array.isArray(season[k])) || null;
}

// Clés qui trahiraient une donnée personnelle : refusées partout dans le payload.
const CLE_PERSO = /(^|_)(user|users|uid|email|mail|pseudo|username|display|avatar|device|league|leagues|profile|profiles)(_|$)/i;

// ---------------------------------------------------------------- validation
// Renvoie la liste des problèmes (vide si le payload respecte le contrat).
export function validerSnapshot(p) {
  const pb = [];
  const P = (m) => { if (pb.length < 40) pb.push(m); };
  if (!isObj(p)) return ['payload absent ou qui n\'est pas un objet'];
  if (p.version !== 1) P(`version ${JSON.stringify(p.version)} (attendu 1)`);
  if (!isIsoTs(p.generated_at)) P('generated_at absent ou invalide');
  // Données personnelles : aucune clé suspecte, à n'importe quelle profondeur.
  (function walk(o, at) {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (isObj(o)) for (const k of Object.keys(o)) {
      if (CLE_PERSO.test(k)) P(`clé interdite « ${k} » (${at}) : aucune donnée personnelle dans le payload`);
      walk(o[k], `${at}.${k}`);
    }
  })(p, 'payload');

  if (!Array.isArray(p.nights)) P('nights absent (liste attendue)');
  else p.nights.forEach((n, i) => {
    const at = `nights[${i}]`;
    if (!isObj(n)) return P(`${at} n'est pas un objet`);
    if (!isIsoDate(n.date)) P(`${at}.date invalide`);
    if (!Array.isArray(n.games)) return P(`${at}.games absent`);
    n.games.forEach((g, j) => {
      const a = `${at}.games[${j}]`;
      if (!isObj(g)) return P(`${a} n'est pas un objet`);
      if (!isIsoTs(g.tip_off)) P(`${a}.tip_off invalide`);
      if (!STATUTS.has(g.status)) P(`${a}.status « ${g.status} » inconnu`);
      for (const side of ['home', 'away']) {
        const t = g[side];
        if (!isObj(t) || typeof t.abbr !== 'string' || !t.abbr || typeof t.city !== 'string' || typeof t.name !== 'string' || !t.name) P(`${a}.${side} incomplet (abbr, city, name)`);
      }
      for (const s of ['home_score', 'away_score']) if (!(g[s] === null || g[s] === undefined || isInt(g[s]))) P(`${a}.${s} doit être un entier ou null`);
      if (g.status === 'final' && !(isInt(g.home_score) && isInt(g.away_score))) P(`${a} : match final sans score`);
      if (!(g.overtime === null || g.overtime === undefined || typeof g.overtime === 'boolean')) P(`${a}.overtime doit être un booléen ou null`);
      if (g.stage !== undefined && !STAGES.has(g.stage)) P(`${a}.stage « ${g.stage} » inconnu (regular, playoffs, other)`);
    });
  });

  if (!Array.isArray(p.community)) P('community absent (liste attendue, vide si rien au-dessus du seuil)');
  else p.community.forEach((c, i) => {
    const at = `community[${i}]`;
    if (!isObj(c) || !isIsoDate(c.game_date) || !Array.isArray(c.games_over_threshold)) return P(`${at} incomplet (game_date, games_over_threshold)`);
    c.games_over_threshold.forEach((g, j) => {
      const a = `${at}.games_over_threshold[${j}]`;
      if (!isObj(g) || typeof g.home_abbr !== 'string' || typeof g.away_abbr !== 'string') return P(`${a} incomplet`);
      // picks n'est plus publié (seuil appliqué en SQL, plan 5.2 : seulement des pourcentages) ; toléré s'il revient.
      if (g.picks !== undefined && !isInt(g.picks)) P(`${a}.picks doit être un entier s'il est présent`);
      for (const k of ['home_pct', 'exact_pct']) if (!isInt(g[k]) || g[k] < 0 || g[k] > 100) P(`${a}.${k} doit être un entier de 0 à 100`);
    });
  });

  const s = p.season;
  if (!isObj(s)) P('season absent');
  else {
    if (typeof s.label !== 'string' || !s.label) P('season.label absent');
    const m = s.margins;
    if (!isObj(m)) P('season.margins absent');
    else {
      if (!isInt(m.games)) P('season.margins.games doit être un entier');
      for (const k of ['mean', 'median']) if (!(isNum(m[k]) || (m.games === 0 && m[k] === null))) P(`season.margins.${k} doit être un nombre`);
      if (!(isInt(m.within5_pct) || (m.games === 0 && m.within5_pct === null))) P('season.margins.within5_pct doit être un entier');
      if (!(m.overtime_pct === null || m.overtime_pct === undefined || isInt(m.overtime_pct))) P('season.margins.overtime_pct doit être un entier ou null');
      if (!Array.isArray(m.histogram) || m.histogram.some((h) => !isObj(h) || typeof h.label !== 'string' || !isInt(h.count))) P('season.margins.histogram : liste de { label, count } attendue');
      for (const k of Object.keys(m)) if (/team|equipe|home_|away_/.test(k)) P(`season.margins.${k} : aucune ventilation par équipe ni domicile/extérieur (plan, 5.1)`);
    }
    if (!Array.isArray(s.nights_by_month) || s.nights_by_month.some((x) => !isObj(x) || !/^\d{4}-\d{2}$/.test(x.month) || !isInt(x.nights) || !isInt(x.nights_5plus) || !(x.games === undefined || x.games === null || isInt(x.games)))) P('season.nights_by_month : liste de { month: AAAA-MM, nights, nights_5plus, games } attendue');
    const k = cleRepartition(s);
    if (!k) P('season : répartition des coups d\'envoi (clé tipoff_…) absente');
    else if (s[k].some((x) => !isObj(x) || typeof x.label !== 'string' || !isInt(x.count))) P(`season.${k} : liste de { label, count } attendue`);
  }
  return pb;
}

// Toutes les valeurs texte du payload (pour le contrôle du lexique : clés exclues).
export function textesDuPayload(p) {
  const out = [];
  (function walk(o) {
    if (typeof o === 'string') out.push(o);
    else if (Array.isArray(o)) o.forEach(walk);
    else if (isObj(o)) Object.values(o).forEach(walk);
  })(p);
  return out.join(' . ');
}

// ---------------------------------------------------------------- heures et dates
// Heure française = règle européenne : heure d'été du dernier dimanche de mars (1 h UTC) au
// dernier dimanche d'octobre (1 h UTC), soit UTC+2 ; UTC+1 le reste de l'année.
function dernierDimancheUtc(annee, mois0) {
  const fin = new Date(Date.UTC(annee, mois0 + 1, 0));
  return Date.UTC(annee, mois0, fin.getUTCDate() - fin.getUTCDay(), 1);
}
export function decalageFr(ms) {
  const y = new Date(ms).getUTCFullYear();
  return ms >= dernierDimancheUtc(y, 2) && ms < dernierDimancheUtc(y, 9) ? 2 : 1;
}
export function heureFr(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  const d = new Date(ms + decalageFr(ms) * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay(), iso: d.toISOString().slice(0, 10) };
}
// Date du jour à New York (journée de championnat, game_date).
export function dateNewYork(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export function ajouterJours(iso, n) {
  const d = new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5);
  return d.toISOString().slice(0, 10);
}
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const jourNum = (d) => (d === 1 ? '1er' : String(d));
function partsDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
export const dateCourte = (iso) => iso.split('-').reverse().join('/');
export function moisLong(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const s = `${MOIS[m - 1]} ${y}`;
  return s[0].toUpperCase() + s.slice(1);
}
// « nuit du mardi 25 au mercredi 26 novembre » pour la journée US du 25.
export function libelleNuit(gameDate) {
  const a = partsDate(gameDate);
  const b = partsDate(ajouterJours(gameDate, 1));
  const fin = `${JOURS[b.dow]} ${jourNum(b.d)} ${MOIS[b.m - 1]}${a.y !== b.y ? ' ' + b.y : ''}`;
  if (a.y !== b.y) return `nuit du ${JOURS[a.dow]} ${jourNum(a.d)} ${MOIS[a.m - 1]} ${a.y} au ${fin}`;
  if (a.m !== b.m) return `nuit du ${JOURS[a.dow]} ${jourNum(a.d)} ${MOIS[a.m - 1]} au ${fin}`;
  return `nuit du ${JOURS[a.dow]} ${jourNum(a.d)} au ${fin}`;
}
// « 1 h », « 1 h 30 », « 21 h 05 »
export function heureTexte(iso) {
  const p = heureFr(iso);
  return p.min ? `${p.h} h ${String(p.min).padStart(2, '0')}` : `${p.h} h`;
}
function horodatageTexte(iso) {
  const p = heureFr(iso);
  return `${JOURS[p.dow]} ${jourNum(p.d)} ${MOIS[p.m - 1]} ${p.y} à ${p.min ? `${p.h} h ${String(p.min).padStart(2, '0')}` : `${p.h} h`}`;
}

// ---------------------------------------------------------------- outils de rendu
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (n) => `${n}&nbsp;%`;
const virgule = (x, dec = 1) => (Number.isInteger(x) && dec === 0 ? String(x) : Number(x).toFixed(dec).replace(/\.0+$/, '').replace('.', ','));
const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
const equipe = (t) => esc(`${t.city ? t.city + ' ' : ''}${t.name}`.trim());
const affiche = (g) => `${equipe(g.home)} contre ${equipe(g.away)}`;
const joue = (g) => g.status !== 'postponed' && g.status !== 'canceled';
const parCoupDEnvoi = (a, b) => Date.parse(a.tip_off) - Date.parse(b.tip_off);

function nuitsTriees(snap) {
  return (snap.nights || [])
    .filter((n) => n && isIsoDate(n.date) && Array.isArray(n.games))
    .map((n) => ({ date: n.date, games: n.games.slice().sort(parCoupDEnvoi) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Nuit à venir (ou en cours), récap et nuit suivante, à partir de l'heure du build.
export function choisirNuits(snap, nowMs) {
  const J = dateNewYork(nowMs);
  const nuits = nuitsTriees(snap);
  const aVenir = nuits.find((n) => n.date >= J && n.games.some((g) => g.status === 'scheduled' || g.status === 'live')) || null;
  const borne = aVenir ? aVenir.date : ajouterJours(J, 1);
  // Le récap ne remonte pas au-delà de J-2 (fenêtre de l'export) : un instantané périmé ne doit pas
  // présenter comme « la dernière nuit » une nuit vieille d'une semaine.
  const recap = [...nuits].reverse().find((n) => n.date < borne && n.date <= J && n.date >= ajouterJours(J, -2) && n.games.some((g) => g.status === 'final')) || null;
  const suivante = aVenir ? nuits.find((n) => n.date > aVenir.date && n.games.some(joue)) || null : null;
  const derniere = nuits.length ? nuits[nuits.length - 1].date : null;
  return { J, nuits, aVenir, recap, suivante, derniere };
}

function mvpEnJeu(nuit, B) {
  const mvp = (B && B.mvp) || {};
  return Boolean(mvp.depuis && nuit.date >= mvp.depuis && nuit.games.filter(joue).length >= (mvp.minMatchs || 5));
}

// ---------------------------------------------------------------- blocs de /ce-soir/
// ctx : { snap, mode: 'live'|'apercu'|'repli', now (ms), bareme, donnees (config), warn(msg) }

function blocProgramme(ctx) {
  if (!ctx.snap) {
    return `<h2>Le programme de la nuit</h2>
<p>Le programme de la nuit n'a pas pu être chargé pour l'instant. Les matchs, avec leur heure française et leur verrouillage, sont dans l'appli, souvent plusieurs jours à l'avance.</p>`;
  }
  const { J, aVenir, derniere } = choisirNuits(ctx.snap, ctx.now);
  // Instantané périmé (actualisation en panne) : ne jamais conclure « pas de match » à partir de vieilles
  // données. Même message neutre que sans données.
  if (!aVenir && (estVieux(ctx) || !derniere || derniere < J)) {
    return `<h2>Le programme de la nuit</h2>
<p>Le programme de la nuit n'a pas pu être actualisé pour l'instant. Les matchs, avec leur heure française et leur verrouillage, sont dans l'appli, souvent plusieurs jours à l'avance.</p>`;
  }
  if (!aVenir) {
    const jusqu = derniere && derniere >= J ? ` d'ici la ${libelleNuit(derniere)}` : ' dans les prochains jours';
    return `<h2>Pas de match annoncé pour l'instant</h2>
<p>Aucun match n'est au programme${jusqu}. Ça arrive pendant la pause du All-Star et à l'intersaison. Les grandes dates de l'année sont sur <a href="/saison/">le calendrier de la saison</a>.</p>`;
  }
  const jouables = aVenir.games.filter(joue);
  const reportes = aVenir.games.filter((g) => !joue(g));
  const aJouer = jouables.filter((g) => g.status === 'scheduled' && Date.parse(g.tip_off) > ctx.now);
  const premier = jouables[0];
  const pills = [`<li class="pill">${pluriel(jouables.length, 'match', 'matchs')}</li>`];
  if (mvpEnJeu(aVenir, ctx.bareme)) pills.push('<li class="pill on">MVP de la Night en jeu</li>');
  if (premier && Date.parse(premier.tip_off) > ctx.now) pills.push(`<li class="pill">Jouable avant ${heureTexte(premier.tip_off)}</li>`);
  else if (aJouer.length) pills.push(`<li class="pill">Encore jouable avant ${heureTexte(aJouer[0].tip_off)}</li>`);
  const pasCeSoir = (estVieux(ctx) ? `<p class="note">Données arrêtées au ${horodatageTexte(ctx.snap.generated_at)} : horaires et reports peuvent avoir changé depuis, l'appli a la version à jour.</p>\n` : '')
    + (aVenir.date > J ? `<p>Pas de match la ${libelleNuit(J)}. Prochaine nuit au programme :</p>\n` : '');
  const lignes = aVenir.games.map((g) => {
    let quand;
    if (g.status === 'postponed') quand = 'Reporté';
    else if (g.status === 'canceled') quand = 'Annulé';
    else if (g.status === 'final') quand = 'Terminé';
    else if (g.status === 'live') quand = 'En cours';
    else quand = heureTexte(g.tip_off);
    const cls = joue(g) ? '' : ' class="off"';
    const score = g.status === 'final' ? ` <span class="muted">(${g.home_score}-${g.away_score})</span>` : '';
    return `<tr${cls}><td class="pts">${quand}</td><td>${affiche(g)}${score}</td></tr>`;
  }).join('\n');
  const notes = ['L\'équipe qui reçoit est citée en premier.'];
  if (reportes.length) notes.push(`${pluriel(reportes.length, 'match reporté ou annulé', 'matchs reportés ou annulés')} : ${reportes.length > 1 ? 'ils sortent' : 'il sort'} du compte de la nuit.`);
  return `<h2>Le programme de la ${libelleNuit(aVenir.date)}</h2>
${pasCeSoir}<ul class="pills">${pills.join('')}</ul>
<p>Chaque prono se verrouille au coup d'envoi de son match${premier ? `, et le premier de la nuit démarre à ${heureTexte(premier.tip_off)}, heure française` : ''}.</p>
<div class="table"><table>
<thead><tr><th>Heure française</th><th>Affiche</th></tr></thead>
<tbody>
${lignes}
</tbody>
</table></div>
<p class="muted">${notes.join(' ')}</p>`;
}

function blocRecap(ctx) {
  if (!ctx.snap) return '';
  const { recap } = choisirNuits(ctx.snap, ctx.now);
  if (!recap) return `<h2>Le récap de la dernière nuit</h2>
<p>${estVieux(ctx) ? 'Pas de récap pour l\'instant : les résultats n\'ont pas pu être actualisés. Ils sont dans l\'appli dès la fin des matchs.' : 'Pas de récap pour l\'instant : aucun match terminé ces deux derniers jours.'}</p>`;
  const finals = recap.games.filter((g) => g.status === 'final');
  const serres = finals.filter((g) => Math.abs(g.home_score - g.away_score) <= 5).length;
  const otConnu = finals.length && finals.every((g) => typeof g.overtime === 'boolean');
  const ot = finals.filter((g) => g.overtime === true).length;
  const lignes = recap.games.map((g) => {
    if (g.status === 'final') {
      const ecart = Math.abs(g.home_score - g.away_score);
      return `<tr><td>${affiche(g)}</td><td>${g.home_score}-${g.away_score}${g.overtime ? ' <span class="muted">a.p.</span>' : ''}</td><td class="pts">${ecart}</td></tr>`;
    }
    const etat = g.status === 'postponed' ? 'Reporté' : g.status === 'canceled' ? 'Annulé' : 'Score pas encore connu';
    return `<tr class="off"><td>${affiche(g)}</td><td colspan="2">${etat}</td></tr>`;
  }).join('\n');
  let resume = `${pluriel(finals.length, 'match terminé', 'matchs terminés')}`;
  resume += serres ? `, dont ${serres} ${serres > 1 ? 'décidés' : 'décidé'} à 5 points ou moins` : ', aucun décidé à 5 points ou moins';
  if (otConnu) resume += ot ? ` et ${ot} après prolongation` : ', sans prolongation';
  return `<h2>Le récap de la ${libelleNuit(recap.date)}</h2>
<p>${resume}.</p>
<div class="table"><table>
<thead><tr><th>Affiche</th><th>Score</th><th>Écart</th></tr></thead>
<tbody>
${lignes}
</tbody>
</table></div>
<p class="muted">Score de l'équipe qui reçoit en premier${otConnu && ot ? ' ; a.p. : après prolongation' : ''}.</p>`;
}

function blocCommunaute(ctx) {
  const invite = '<p class="note">Fais ton prono de la nuit dans l\'app : le bilan des joueurs de Dunk League s\'affiche ici quand un match terminé a reçu assez de pronos.</p>';
  if (!ctx.snap) return invite;
  const { recap } = choisirNuits(ctx.snap, ctx.now);
  if (!recap) return invite;
  const seuil = (ctx.donnees && ctx.donnees.seuilCommunaute) || 30;
  const entree = (ctx.snap.community || []).find((c) => c.game_date === recap.date);
  const lignes = [];
  for (const c of (entree && entree.games_over_threshold) || []) {
    const g = recap.games.find((x) => x.status === 'final' && x.home.abbr === c.home_abbr && x.away.abbr === c.away_abbr);
    if (!g) continue;
    // Le seuil est appliqué en SQL (seuls les matchs d'au moins 30 pronos sont exportés, sans leur nombre) ;
    // si un ancien instantané porte encore picks, on revérifie.
    if (c.picks !== undefined && !(c.picks >= seuil)) { ctx.warn(`communauté : ${c.home_abbr}-${c.away_abbr} sous le seuil de ${seuil} pronos, ignoré`); continue; }
    let { home_pct: hp, exact_pct: ep } = c;
    if (hp % 5 || ep % 5) { ctx.warn(`communauté : pourcentages non arrondis à 5 pour ${c.home_abbr}-${c.away_abbr}, arrondis par le build`); hp = Math.round(hp / 5) * 5; ep = Math.round(ep / 5) * 5; }
    const bon = g.home_score > g.away_score ? hp : 100 - hp;
    lignes.push(`<tr><td>${affiche(g)}</td><td class="pts">${pct(bon)}</td><td class="pts">${pct(ep)}</td></tr>`);
  }
  if (!lignes.length) return invite;
  return `<h2>Les joueurs de Dunk League sur cette nuit</h2>
<p>Pour les matchs terminés qui ont reçu au moins ${seuil} pronos, voici la part des joueurs qui avaient trouvé le bon vainqueur, puis l'écart exact.</p>
<div class="table"><table>
<thead><tr><th>Affiche</th><th>Bon vainqueur</th><th>Écart exact</th></tr></thead>
<tbody>
${lignes.join('\n')}
</tbody>
</table></div>
<p class="muted">Pourcentages arrondis à 5 points, publiés seulement après le match.</p>`;
}

function blocDemain(ctx) {
  if (!ctx.snap) return '';
  const { aVenir, suivante } = choisirNuits(ctx.snap, ctx.now);
  if (!aVenir) return '';
  const demain = ajouterJours(aVenir.date, 1);
  let txt;
  if (!suivante) txt = 'Le programme des nuits suivantes n\'est pas encore dans nos données : il est déjà dans l\'appli.';
  else {
    const jouables = suivante.games.filter(joue);
    const desc = `${pluriel(jouables.length, 'match', 'matchs')}, premier coup d'envoi à ${heureTexte(jouables[0].tip_off)}, heure française${mvpEnJeu(suivante, ctx.bareme) ? ', avec le MVP de la Night en jeu' : ''}`;
    txt = suivante.date === demain
      ? `La ${libelleNuit(suivante.date)} : ${desc}.`
      : `Pas de match la ${libelleNuit(demain)}. Les matchs reprennent la ${libelleNuit(suivante.date)} : ${desc}.`;
  }
  return `<h2>Et demain soir ?</h2>
<p>${txt}</p>`;
}

function estVieux(ctx) {
  return Boolean(ctx.snap) && ctx.now - Date.parse(ctx.snap.generated_at) > ((ctx.donnees && ctx.donnees.fraicheurMaxHeures) || 36) * 3600e3;
}
function blocFraicheur(ctx) {
  if (!ctx.snap) return '';
  const g = ctx.snap.generated_at;
  const vieux = estVieux(ctx);
  return `<p class="muted">Programme et scores d'après les données de l'appli, actualisées le ${horodatageTexte(g)}, heure française.${vieux ? ' Elles n\'ont pas pu être actualisées depuis : les horaires à jour sont dans l\'appli.' : ''}</p>`;
}

// Encart « Cette nuit » (accueil) : les premiers matchs de la nuit à venir.
export function blocCetteNuit(ctx, { lien = null, nb = 3 } = {}) {
  if (!ctx.snap) return '';
  const { aVenir } = choisirNuits(ctx.snap, ctx.now);
  if (!aVenir) return '';
  const jouables = aVenir.games.filter(joue);
  if (!jouables.length) return '';
  const items = jouables.slice(0, nb).map((g) => `<li><b>${heureTexte(g.tip_off)}</b> ${affiche(g)}</li>`).join('');
  const autres = jouables.length - nb;
  const suite = lien
    ? `<p><a href="${lien}">Tout le programme de la nuit</a>${autres > 0 ? `, avec ${pluriel(autres, 'autre match', 'autres matchs')}` : ''}.</p>`
    : autres > 0 ? `<p>Et ${pluriel(autres, 'autre match', 'autres matchs')} dans l'appli.</p>` : '';
  return `<section class="tonight" aria-labelledby="cette-nuit"><h2 id="cette-nuit">Cette nuit</h2>
<p class="muted">La ${libelleNuit(aVenir.date)}, heure française${mvpEnJeu(aVenir, ctx.bareme) ? ' · MVP de la Night en jeu' : ''}.</p>
<ul class="tonight-l">${items}</ul>
${suite}</section>`;
}

// ---------------------------------------------------------------- blocs de saison
function dateDonnees(ctx) {
  return ctx.snap ? dateCourte(heureFr(ctx.snap.generated_at).iso) : null;
}
function lignesMois(ctx) {
  if (ctx.snap) return { rows: ctx.snap.season.nights_by_month.map((r) => ({ ...r, libelle: moisLong(r.month) })), legende: `Nuits déjà jouées (matchs terminés), d'après les données de l'appli, au ${dateDonnees(ctx)}.` };
  const f = ctx.figees && ctx.figees.nightsByMonth;
  if (!f) return null;
  return { rows: f.rows.map((r) => ({ ...r, libelle: r.libelle || moisLong(r.month) })), legende: f.legende };
}

// /saison/ : nuits avec des matchs et nuits d'au moins 5 matchs, mois par mois.
const NOTE_SAISON_VIDE = '<p class="note">Pas encore de nuit jouée cette saison : le tableau arrive avec les premiers matchs.</p>';
const NOTE_HEURES_VIDE = '<p class="note">Pas encore de match joué cette saison : la répartition arrive avec les premiers matchs.</p>';
function blocNuitsParMois(ctx) {
  const L = lignesMois(ctx);
  if (!L || !L.rows.length) { if (ctx.snap) ctx.warn('auto:nuits-par-mois : aucune nuit dans les données, note neutre affichée'); return NOTE_SAISON_VIDE; }
  const avecMatchs = L.rows.every((r) => Number.isInteger(r.games));
  const rows = L.rows.map((r) => `<tr><td>${esc(r.libelle)}</td><td>${r.nights}</td><td class="pts">${r.nights_5plus}</td>${avecMatchs ? `<td>${r.games}</td>` : ''}</tr>`).join('\n');
  return `<div class="table"><table>
<thead><tr><th>Mois</th><th>Nuits avec des matchs</th><th>Nuits d'au moins 5 matchs</th>${avecMatchs ? '<th>Matchs</th>' : ''}</tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<p class="muted">${esc(L.legende)}</p>`;
}

// /regles/bonus/ : nuits d'au moins 5 matchs par mois, en part des nuits de matchs.
function blocNuits5ParMois(ctx) {
  const L = lignesMois(ctx);
  if (!L || !L.rows.length) { if (ctx.snap) ctx.warn('auto:nuits-5-par-mois : aucune nuit dans les données, note neutre affichée'); return NOTE_SAISON_VIDE; }
  const rows = L.rows.map((r) => `<tr><td>${esc(r.libelle)}</td><td class="pts">${r.nights_5plus}</td><td>${r.nights ? pct(Math.round((r.nights_5plus / r.nights) * 100)) : '—'}</td></tr>`).join('\n');
  return `<div class="table"><table>
<thead><tr><th>Mois</th><th>Nuits d'au moins 5 matchs</th><th>Part des nuits de matchs</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<p class="muted">${esc(L.legende)}</p>`;
}

// /heure-des-matchs/ : répartition des coups d'envoi en heure française.
const LIBELLES_HEURES = { 'avant minuit': 'Avant minuit', '0 h - 1 h': 'Entre minuit et 1 h', '1 h - 2 h': 'Entre 1 h et 2 h', '2 h - 3 h': 'Entre 2 h et 3 h', '3 h - 4 h': 'Entre 3 h et 4 h', '4 h - 5 h': 'Entre 4 h et 5 h', '5 h et après': '5 h et après' };
function blocHeures(ctx) {
  let rows;
  let legende;
  if (ctx.snap) {
    rows = ctx.snap.season[cleRepartition(ctx.snap.season)];
    legende = `Matchs joués de la saison ${ctx.snap.season.label}, au ${dateDonnees(ctx)}, heure française. Parts arrondies.`;
  } else if (ctx.figees && ctx.figees.tipoff) {
    rows = ctx.figees.tipoff.rows;
    legende = ctx.figees.tipoff.legende;
  } else return NOTE_HEURES_VIDE;
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (!total) { if (ctx.snap) ctx.warn('auto:heures : aucun coup d\'envoi dans les données, note neutre affichée'); return NOTE_HEURES_VIDE; }
  const lignes = rows.map((r) => `<tr><td>${esc(LIBELLES_HEURES[r.label] || r.label)}</td><td>${r.count}</td><td class="pts">${pct(Math.round((r.count / total) * 100))}</td></tr>`).join('\n');
  return `<div class="table"><table>
<thead><tr><th>Coup d'envoi (heure française)</th><th>Matchs</th><th>Part</th></tr></thead>
<tbody>
${lignes}
</tbody>
</table></div>
<p class="muted">${esc(legende)} Total : ${total} matchs.</p>`;
}

// /ecart-de-points/ : écart moyen, médian, part à ±5, prolongations et histogramme (toute la ligue).
// « 1-3 » → « 1 à 3 » (axe) ou « 1 à 3 points » (description) ; « 21+ » → « 21 et plus » ou « 21 points ou plus ».
function libelleTranche(l, avecUnite = false) {
  const s = String(l).trim();
  let m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return `${m[1]} à ${m[2]}${avecUnite ? ' points' : ''}`;
  m = s.match(/^(\d+)\s*\+$/);
  if (m) return avecUnite ? `${m[1]} points ou plus` : `${m[1]} et plus`;
  return s;
}
// Source des écarts : l'instantané, sinon le relevé vérifié de _data/figees.json (clé margins).
function sourceEcarts(ctx) {
  if (ctx.snap) {
    const m = ctx.snap.season.margins;
    return { m, label: ctx.snap.season.label, legende: `${pluriel(m.games, 'match terminé', 'matchs terminés')} de la saison ${ctx.snap.season.label} hors playoffs, toute la ligue, au ${dateDonnees(ctx)}.` };
  }
  const f = ctx.figees && ctx.figees.margins;
  if (!f || !isInt(f.games) || !Array.isArray(f.histogram)) return null;
  return { m: f, label: f.label || '', legende: f.legende };
}
export function blocEcarts(ctx) {
  const S = sourceEcarts(ctx);
  if (!S) return '<p class="note">Les chiffres de la saison s\'affichent ici à chaque actualisation des données de l\'appli.</p>';
  const m = S.m;
  if (!m.games) {
    if (ctx.snap) ctx.warn('auto:ecarts : aucun match terminé dans les données, note neutre affichée');
    return '<p class="note">Pas encore de match terminé cette saison : les chiffres arrivent avec les premiers résultats.</p>';
  }
  const tuiles = [
    `<li class="stat"><b>${virgule(m.mean, 1)}</b><span>points d'écart en moyenne</span></li>`,
    `<li class="stat"><b>${virgule(m.median, 1)}</b><span>points d'écart médian</span></li>`,
    `<li class="stat"><b>${pct(m.within5_pct)}</b><span>des matchs décidés à 5 points ou moins</span></li>`,
  ];
  if (Number.isInteger(m.overtime_pct)) tuiles.push(`<li class="stat"><b>${pct(m.overtime_pct)}</b><span>des matchs allés en prolongation</span></li>`);
  const H = m.histogram;
  const max = Math.max(1, ...H.map((h) => h.count));
  const W = 600, HT = 250, top = 28, bas = 34, pas = (W - 20) / Math.max(1, H.length), lb = Math.min(64, pas * 0.68);
  const barres = H.map((h, i) => {
    const hh = Math.round(((HT - top - bas) * h.count) / max);
    const x = Math.round(10 + i * pas + (pas - lb) / 2);
    const cx = Math.round(10 + i * pas + pas / 2);
    const y = HT - bas - hh;
    return `<rect class="bar" x="${x}" y="${y}" width="${Math.round(lb)}" height="${Math.max(hh, h.count ? 2 : 0)}" rx="4"></rect><text class="val" x="${cx}" y="${y - 8}">${h.count}</text><text x="${cx}" y="${HT - 12}">${esc(libelleTranche(h.label))}</text>`;
  }).join('');
  const desc = H.map((h) => `${libelleTranche(h.label, true)} : ${pluriel(h.count, 'match', 'matchs')}`).join(' ; ');
  const uid = 'histo-' + (ctx.seq = (ctx.seq || 0) + 1);
  return `<ul class="stats">${tuiles.join('')}</ul>
<figure class="histo">
<svg viewBox="0 0 ${W} ${HT}" role="img" aria-labelledby="${uid}-t ${uid}-d"><title id="${uid}-t">Répartition des matchs par écart de points final${S.label ? `, saison ${esc(S.label)}` : ''}</title><desc id="${uid}-d">${esc(desc)}.</desc><line class="axe" x1="10" y1="${HT - bas}" x2="${W - 10}" y2="${HT - bas}"></line>${barres}</svg>
<figcaption>Écart de points final, en nombre de matchs. ${esc(S.legende)}</figcaption>
</figure>`;
}

// ---------------------------------------------------------------- marqueurs
export const MARQUEURS = {
  programme: blocProgramme,
  recap: blocRecap,
  communaute: blocCommunaute,
  demain: blocDemain,
  fraicheur: blocFraicheur,
  'cette-nuit': (ctx) => blocCetteNuit(ctx),
  ecarts: blocEcarts,
  'nuits-par-mois': blocNuitsParMois,
  'nuits-5-par-mois': blocNuits5ParMois,
  heures: blocHeures,
};

// ---------------------------------------------------------------- contrôles sur les données
// Export vide un jour où le calendrier annonce des matchs (plan, 5.3, contrôles bloquants).
export function controleExportVide(snap, nowMs, conf) {
  if (!snap || !conf || !conf.saison) return null;
  const J = dateNewYork(nowMs);
  const total = (snap.nights || []).reduce((s, n) => s + ((n && Array.isArray(n.games)) ? n.games.length : 0), 0);
  if (total) return null;
  const S = conf.saison;
  if (J < S.debut || J > S.finSaisonReguliere) return null;
  const du = ajouterJours(J, -2);
  const au = ajouterJours(J, 3);
  if ((S.pauses || []).some((p) => p.du <= du && p.au >= au)) return null;
  // Une fenêtre qui chevauche une pause peut être vide si ses autres jours n'ont pas de match (rare) : signalé quand même.
  return `export vide (aucun match du ${dateCourte(du)} au ${dateCourte(au)}) alors que la saison régulière est en cours`;
}
