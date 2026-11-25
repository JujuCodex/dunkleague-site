# dunkleague.app

Site statique de [Dunk League](https://dunkleague.app) — l'app de pronostics
basket entre potes (gratuite, sans argent réel).

Hébergé sur GitHub Pages, domaine géré chez OVH (DNS + email).

- `index.html` — landing
- `privacy/` — politique de confidentialité (URL des fiches stores et du message RGPD AdMob)
- `app-ads.txt` — vérification annonceurs AdMob
- `CNAME` — domaine personnalisé GitHub Pages

## Générateur

Les pages du site sont écrites dans `_src/pages/` et transformées en HTML final
par `_scripts/build.mjs` (Node 20 ou plus, Node 24 en CI et en local, aucune dépendance, rien à installer).
Le HTML produit est écrit directement à la racine du dépôt, que GitHub Pages sert
tel quel : on commite les sources **et** les pages générées.

```
node _scripts/build.mjs            # contrôle, puis écrit les pages, sitemap.xml et 404.html
node _scripts/build.mjs --check    # contrôle seulement, n'écrit rien
node _scripts/build.mjs --prune    # supprime aussi les pages générées dont la source a disparu
node _scripts/build.mjs --hash "expression"   # empreinte à ajouter au lexique
node _scripts/build.mjs --sample   # aperçu avec les données FICTIVES, écrit dans _preview/ (jamais à la racine)
node _scripts/build.mjs --data=fichier.json --now=2026-12-02T16:00:00Z   # test d'un autre payload, dans _preview/
node _scripts/fetch-snapshot.mjs   # télécharge les données de l'app dans _data/snapshot.json (voir plus bas)
node _scripts/assemble-site.mjs    # assemble _site/ pour GitHub Pages (CI)
```

Tant que GitHub Pages sert le site depuis la branche `main`, on commite les pages
générées comme avant. Après la bascule sur GitHub Actions (voir « Publication par
GitHub Actions »), c'est le workflow qui génère et publie : les pages commitées à la
racine ne sont plus servies, mais restent utiles pour relire un changement.

S'il reste **une seule erreur**, le build s'arrête (code 1) et n'écrit rien. Les
avertissements n'empêchent pas l'écriture mais se relisent avant publication.

### Dossiers

| Chemin | Rôle |
|---|---|
| `_src/pages/` | une source par page (voir ci-dessous) |
| `_config/site.json` | nom, URL, liens des stores, Instagram, menu, pied de page, pages écrites à la main |
| `_config/bareme.json` | barème du jeu, injecté par marqueurs |
| `_config/lexique.json` | lexique proscrit, liste d'alerte et marques, **uniquement en empreintes SHA-256** |
| `_config/exceptions.json` | exceptions relues à la main (slug historique `/mpp-basket/`) |
| `_config/build-state.json` | empreintes du contenu, écrites par le build (contrôle de `modifiedOn`) |
| `_scripts/build.mjs` | le générateur |
| `_scripts/donnees.mjs` | contrat des données de l'app, validation, rendu des blocs `{{auto:…}}` |
| `_scripts/fetch-snapshot.mjs` | téléchargement de la table `site_snapshot` vers `_data/snapshot.json` |
| `_scripts/assemble-site.mjs` | assemblage et vérification du dossier `_site/` publié par la CI |
| `_config/donnees.json` | dates de saison (contrôle « export vide »), fraîcheur max, seuil communauté |
| `_data/snapshot.json` | dernier instantané réel, **jamais commité** (`.gitignore`) |
| `_data/snapshot.sample.json` | instantané d'exemple, données **fictives**, pour `--sample` |
| `_data/figees.json` | chiffres de repli vérifiés en vague 1, affichés quand aucune donnée réelle n'est disponible |
| `.github/workflows/site.yml` | build et publication par GitHub Actions |

Ces dossiers sont publics sur GitHub Pages (le site est servi depuis la racine) :
`robots.txt` les exclut de l'exploration, mais une source brouillon reste lisible
par qui connaît son adresse. N'y mets rien de confidentiel.

### Ajouter une page

1. Crée `_src/pages/<chemin>.html` :
   - `_src/pages/index.html` → `/`
   - `_src/pages/regles.html` → `/regles/`
   - `_src/pages/regles/bonus.html` → `/regles/bonus/`
   - `_src/pages/saison/index.html` → `/saison/`
2. Commence le fichier par l'en-tête JSON, puis écris le corps HTML :

   ```html
   <!--meta
   {
     "title": "Règles et barème des pronos basket — Dunk League",
     "description": "…",
     "h1": "Les règles du jeu de <em>Dunk League</em>",
     "kicker": "Barème",
     "crumb": "Règles",
     "intro": "Le <strong>barème</strong> de Dunk League en clair…",
     "primaryQuery": ["règles", "barème"],
     "forbiddenInTitle": ["bonus", "MVP"],
     "related": ["/regles/bonus/", "/questions/", "/pronostics-basket-entre-amis/", "/saison/"],
     "schema": ["Article"],
     "ctaCampaign": "regles",
     "gabarit": "guide",
     "modifiedOn": "2026-11-24",
     "faq": [{ "q": "…", "a": "…" }]
   }
   -->
   <h2>Le barème</h2>
   <p>{{bareme.phrases.exact}}.</p>
   ```
3. Lance `node _scripts/build.mjs`, corrige les erreurs, relis les avertissements.
4. Pour reprendre une page écrite à la main (accueil, `/mpp-basket/`, `/support/`),
   ajoute `"replacesLegacy": true` : sans ce champ, le build refuse d'écraser le
   fichier existant. Retire ensuite sa ligne de `legacy.pages` dans `site.json`.

Une page encore en chantier porte `"draft": true` : elle n'est pas générée, et le
build retire les liens qui y mènent (menu, pied de page, pages liées, corps). Pour
lier une page pas encore écrite, crée d'abord sa source en brouillon.

Une page en **préproduction** porte `"preprod": true` (avec `"noindex": true`, exigé) :
elle est générée et servie à son adresse, mais elle reste hors sitemap, hors menu,
hors pied de page, hors pages liées et hors 404, et les liens des autres pages vers
elle sont retirés (texte conservé). C'est le cas de `/ce-soir/` pendant ses 14 jours
de rodage (plan, 5.3.8). Pour l'ouvrir : retirer `preprod` et `noindex`, passer
`inMenu` à `true` (l'entrée existe déjà dans `menu` et `footer` de `site.json`), puis
activer `"homeTonight": true` dans `site.json`.

`"dateFromData": true` (page dont le contenu suit les données, `/ce-soir/`) : avec un instantané
valide, la ligne « Actualisé le » et `WebPage.dateModified` prennent la date de l'instantané
(`generated_at`) au lieu de `modifiedOn`, qui reste la date du texte écrit à la main (sitemap).

Une page `Article` porte `"publishedOn"` (date de la première publication) : sans lui, `datePublished`
suivrait `modifiedOn` à chaque actualisation (avertissement).

`"introPour": ["2026-11", "2026-12"]` déclare les mois pour lesquels l'intro a été
écrite : hors de ces mois (heure française), le build avertit qu'elle est à réécrire.

Les faits non vérifiés restent dans un commentaire de la source,
`<!-- TODO-VERIFIER : … -->` : les commentaires ne sont jamais publiés, et le
build compte ceux qui restent.

### Pages écrites à la main

`auth/`, `beta/`, `delete-account/`, `privacy/` (et l'accueil, `/mpp-basket/`,
`/support/` tant qu'ils n'ont pas de source) ne sont jamais modifiés par le build.
Ils sont déclarés dans `_config/site.json` (`legacy.pages`) avec leur statut
d'indexation et leur `lastmod` : le sitemap reprend ceux qui sont indexables.

### Lexique

Les mots proscrits ne sont écrits en clair nulle part dans le dépôt : le build
compare l'empreinte de chaque mot normalisé (minuscules, sans accents) et de
chaque suite de 2 à 4 mots. Pour ajouter une forme, calcule son empreinte avec
`--hash` et ajoute-la à la bonne liste de `_config/lexique.json`. Le build
analyse aussi les sources, la config, les scripts et ce fichier.

### Données structurées : ce qui est attendu

- Chaque page autre que l'accueil reçoit dans son `@graph` des nœuds minimaux
  `#org`, `#website` (et `#app` si la page y renvoie), avec le même `@id` que sur
  l'accueil : ce n'est pas une seconde entité, c'est ce qui permet à Google de
  résoudre `author`, `publisher`, `isPartOf` et `about` dans la page.
- La Search Console signalera des éléments « Application logicielle » non
  valides sur `/` et `/application-pronostics-basket/`, faute de note
  (`aggregateRating`) ou d'avis (`review`). **C'est attendu et accepté** : le
  plan interdit toute note recopiée des stores ou inventée. Ne jamais
  « corriger » cette erreur en ajoutant une note.

### Logo, badges et images Open Graph

- En-tête : `logo-mark-88.{avif,webp,png}` (88×60, affiché en 44×30) dans un
  `<picture>`. Le grand `logo-mark.png` ne sert plus qu'à `Organization.logo`
  (`logo.schemaSrc` dans `site.json`).
- Tant que les badges officiels FR manquent dans `/badges/`, le build affiche
  des liens texte neutres (« Voir sur l'App Store », « Voir sur Google Play ») qui
  n'imitent pas la forme d'un badge.
- Image Open Graph par défaut : `/og-default.jpg`. Temps forts (`/saison/`,
  `/saison/bercy/`) : `/og-saison.jpg`. Jamais de logo, couleur ou maillot
  d'équipe.

## Données de l'app (vague 2)

Les blocs chiffrés du site viennent d'une seule ligne de la base de l'app : la table
`public.site_snapshot` (migration `0029_site_snapshot.sql` du dépôt `dunk-league`),
écrite par le serveur et lisible par le rôle `anon`. Elle ne contient que des
agrégats déjà filtrés : aucun pseudo, e-mail, identifiant ni nom de ligue.

```
GET https://<ref>.supabase.co/rest/v1/site_snapshot?id=eq.1&select=generated_at,payload
en-tête apikey: <clé anon>
```

### Le contrat (payload version 1)

| Clé | Contenu |
|---|---|
| `version`, `generated_at` | `1`, date ISO UTC |
| `nights[]` | `date` (journée US, J-2 à J+3, J = date du jour à New York), `games[]` : `tip_off` (UTC), `status` (`scheduled`, `live`, `final`, `postponed`, `canceled`), `stage` (`regular`, `playoffs`, `other` ; plan 5.3), `home` et `away` (`abbr`, `city`, `name`), `home_score` et `away_score` (seulement si `final`), `overtime` (booléen ou `null`) |
| `community[]` | `game_date`, `games_over_threshold[]` : `home_abbr`, `away_abbr`, `home_pct` et `exact_pct` (arrondis à 5) ; seulement des matchs terminés et réglés avec au moins 30 pronos. Le nombre de pronos (`picks`) n'est **pas** publié : le seuil est appliqué en SQL (plan 5.2, des pourcentages seulement). Un ancien instantané qui le porterait encore reste accepté et revérifié |
| `season.label` | `2026-27` |
| `season.margins` | `games`, `mean`, `median`, `within5_pct`, `overtime_pct` (ou `null`), `histogram[]` (`label` : `1-3`, `4-6`, `7-10`, `11-15`, `16-20`, `21+` ; `count`) : matchs de `stage` `regular` (tout match hors playoffs pour sync-games, NBA Cup comprise, finale incluse tant qu'elle n'est pas passée en `other`), toute la ligue, **aucune ventilation par équipe** |
| `season.nights_by_month[]` | `month` (AAAA-MM), `nights`, `nights_5plus`, `games` : nuits déjà jouées |
| répartition horaire | clé `tipoff_…` du contrat (le build la retrouve par son préfixe ; `tipoff_fr` est accepté aussi) : `label` (`avant minuit`, `0 h - 1 h` … `5 h et après`), `count` |

`_scripts/donnees.mjs` (`validerSnapshot`) vérifie cette forme et refuse tout
payload qui porterait une clé de donnée personnelle (`user…`, `email`, `pseudo`,
`league…`, etc.). Les textes du payload passent aussi par le lexique.

### Télécharger les données

```
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<clé anon> node _scripts/fetch-snapshot.mjs
```

Le script ne fait jamais échouer le pipeline : variable absente, réseau en panne,
réponse invalide ou instantané plus ancien que celui déjà présent, il garde le
`_data/snapshot.json` existant, affiche un avertissement et sort en code 0.
`_data/snapshot.json` n'est jamais commité.

### Les trois modes du build

| Mode | Quand | Effet |
|---|---|---|
| réel | `_data/snapshot.json` présent et valide | blocs générés avec les données, écriture à la racine |
| aperçu | `--sample` ou `--data=…` | données fictives ou de test, écriture dans `_preview/` **uniquement** (jamais à la racine : rien de fictif ne peut être commité ni servi) |
| repli | aucune donnée valide | chiffres figés vérifiés de `_data/figees.json` sur `/heure-des-matchs/`, `/saison/`, `/regles/bonus/`, `/ecart-de-points/` ; `/ce-soir/` sans programme mais jamais vide ; avertissement |

`--now=AAAA-MM-JJTHH:MM:SSZ` fixe l'instant qui sert à choisir la nuit à venir et le
récap (sinon 16 h UTC le jour de `--today`, sinon maintenant).

Contrôles liés aux données :
- **export vide** (aucun match de J-2 à J+3) pendant la saison régulière, hors pause
  déclarée dans `_config/donnees.json` (week-end All-Star) : **erreur**, rien n'est
  écrit, rien n'est déployé, la version en ligne reste ;
- instantané de plus de 36 h (`fraicheurMaxHeures`) : avertissement, et `/ce-soir/`
  le dit aux visiteurs (jamais de fausse fraîcheur) ;
- instantané qui ne couvre ni J ni J+1 pendant la saison (actualisation en panne, ancien
  fichier gardé par le cache) : avertissement ; `/ce-soir/` affiche « Le programme de la nuit
  n'a pas pu être actualisé » (jamais « pas de match »), et le récap ne remonte jamais avant J-2 ;
- marqueur de saison vide alors que les données sont valides (début de saison, bogue SQL) :
  note neutre (« Pas encore de nuit jouée cette saison… ») et avertissement, jamais un bloc vide ;
- bilan de la communauté sous le seuil ou pourcentage non arrondi à 5 : ignoré ou
  arrondi, avec avertissement.

### Marqueurs de données disponibles

À placer **seuls sur leur ligne** dans le corps d'une source (jamais dans un `<p>`,
jamais dans l'en-tête). Chacun produit un bloc encadré de
`<!--auto:start-->…<!--auto:end-->` : il ne compte pas dans les mots écrits à la
main et ne change pas l'empreinte `lastmod`. Le texte autour s'écrit à la main.

| Marqueur | Page | Contenu |
|---|---|---|
| `{{auto:programme}}` | `/ce-soir/` | H2 « Le programme de la nuit du mardi 25 au mercredi 26 novembre », pastilles (nombre de matchs, « MVP de la Night en jeu » si au moins 5 matchs non reportés à partir du 30/11/2026, « Jouable avant 1 h »), tableau heure française / affiche, matchs reportés signalés ; soir sans match : la prochaine nuit, ou « Pas de match annoncé » |
| `{{auto:recap}}` | `/ce-soir/` | H2 « Le récap de la nuit du … », scores, écarts, prolongations si connues, nombre de matchs décidés à 5 points ou moins |
| `{{auto:communaute}}` | `/ce-soir/` | bilan des joueurs (bon vainqueur, écart exact) sur les matchs terminés au-dessus du seuil ; sinon « Fais ton prono de la nuit dans l'app » |
| `{{auto:demain}}` | `/ce-soir/` | H2 « Et demain soir ? » : nombre de matchs, premier coup d'envoi, MVP en jeu |
| `{{auto:fraicheur}}` | `/ce-soir/` | date et heure (françaises) des données, et mention si elles ont plus de 36 h |
| `{{auto:cette-nuit}}` | toute page | les 3 premiers matchs de la nuit (même encart que celui de l'accueil) |
| `{{auto:ecarts}}` | `/ecart-de-points/` | 3 ou 4 tuiles (`.stats`) : écart moyen, médian, part à 5 points ou moins, part des prolongations si connue ; histogramme SVG accessible (`role="img"`, titre et description qui donnent chaque valeur) ; légende avec le nombre de matchs et la date. Sans données : le relevé vérifié du 25/11/2026 (`_data/figees.json`, clé `margins`), avec sa date |
| `{{auto:nuits-par-mois}}` | `/saison/` | tableau mois / nuits avec des matchs / nuits d'au moins 5 matchs / matchs |
| `{{auto:nuits-5-par-mois}}` | `/regles/bonus/` | tableau mois / nuits d'au moins 5 matchs / part des nuits de matchs |
| `{{auto:heures}}` | `/heure-des-matchs/` | répartition des coups d'envoi en heure française, avec parts et total |

Un marqueur inconnu est une erreur de build. L'encart « Cette nuit » de l'accueil
n'est pas un marqueur : le gabarit l'insère sous la bannière quand
`"homeTonight": true` dans `site.json` (à activer quand `/ce-soir/` sort de
préproduction ; avant, le build avertit et l'encart n'a pas de lien).

Composants CSS ajoutés : `.pills` / `.pill` (`.pill.on` en doré), `tr.off` (ligne
grisée), `.histo` (figure SVG), `.tonight` / `.tonight-l` (encart de l'accueil).

## Publication par GitHub Actions

`.github/workflows/site.yml` tourne à chaque push sur `main`, à la demande
(`workflow_dispatch`) et sur 4 horaires UTC :

| Cron (UTC) | Heure française en hiver | Rôle |
|---|---|---|
| `30 7 * * *` | 8 h 30 | récap de la nuit |
| `0 16 * * *` | 17 h | programme du soir |
| `0 22 * * *` | 23 h | reports de dernière minute |
| `30 8 * * 1` | lundi 9 h 30 | chiffres de la semaine |

En été, ces crons tombent une heure plus tard à l'heure française : les avancer d'une
heure (`30 6`, `0 15`, `0 21`, `30 7`) au passage à l'heure d'été, et revenir en
octobre. GitHub peut les retarder de 10 à 60 minutes.

Étapes : récupération du dépôt (sans garder le jeton dans `.git/config`), Node 24, restauration du dernier instantané (cache
Actions), `fetch-snapshot.mjs`, `build.mjs` (**une erreur arrête tout : pas de
déploiement, la version en ligne reste**), `assemble-site.mjs` (copie tout sauf
`_src`, `_config`, `_scripts`, `_data`, `_preview`, `.github`, `.git`, `.gitignore`,
`README.md`, et vérifie la présence de `CNAME`, `.nojekyll`, `app-ads.txt`, favicons,
logos, `og-default.jpg`, `robots.txt`, `sitemap.xml`, `404.html`, `privacy/`,
`delete-account/`, `auth/`, `beta/` et de chaque URL du sitemap), puis
`actions/upload-pages-artifact@v3` (qui garde les fichiers cachés comme `.nojekyll`)
et `actions/deploy-pages@v4`. Le workflow ne commite rien.

### À faire par le propriétaire du dépôt

1. **Secrets** (Settings › Secrets and variables › Actions › *Secrets*) :
   `SUPABASE_URL` (`https://<ref>.supabase.co`) et `SUPABASE_ANON_KEY` (la clé anon
   de l'app, publique mais gardée en secret pour ne pas l'afficher). Sans eux, le
   build tourne en mode repli.
2. **Base** : appliquer la migration `0029_site_snapshot.sql` et planifier son
   actualisation par le serveur (dépôt `dunk-league`).
3. **Bascule de GitHub Pages** (Settings › Pages › Build and deployment › Source :
   **GitHub Actions**). Le domaine personnalisé `dunkleague.app` reste dans les
   réglages Pages (le fichier `CNAME` n'est plus lu dans ce mode, il reste publié).
   Vérifier que « Enforce HTTPS » est toujours coché.
4. **Variable** (Settings › Secrets and variables › Actions › *Variables*) :
   `PAGES_DEPUIS_ACTIONS` = `oui`. Tant qu'elle n'existe pas, le workflow construit
   et vérifie le site mais **ne déploie pas** : le site reste servi depuis la branche.
   La créer juste après la bascule, puis lancer le workflow à la main.
5. Après la bascule, `robots.txt` n'a plus besoin des lignes `Disallow: /_src/`,
   `/_config/`, `/_scripts/`, `/_data/` (ces dossiers ne sont plus publiés). On les
   garde quand même : elles ne gênent pas et protègent un retour au mode « branche ».

### Le 30/11/2026 (barème à 10 points)

1. Retirer de `_config/bareme.json` les mentions « 8 points avant le 30/11 » et « à partir des
   nuits du 30/11 » (plan, 7), relancer le build.
2. **Refaire le kit presse** : la fiche de faits du zip (`presse/dunk-league-kit-media.zip`,
   `dunk-league-fiche-de-faits.txt`) est un texte figé que le build ne régénère pas. Retirer
   « (8 points pour les matchs joués avant le 30/11/2026) » et « (à partir des nuits du
   30/11/2026) », changer la date « Actualisée le », puis refaire le zip (mêmes fichiers).

### La finale de la NBA Cup (vendredi 11/12/2026)

sync-games classe en `regular` tout match qui n'est pas de playoffs : la finale de la NBA Cup,
qui ne compte pas au classement de la saison régulière, entrerait dans les écarts de
`/ecart-de-points/`. Une fois le match en base, le passer en `stage = 'other'` (migration 0009,
valeur prévue pour ce cas) ; les textes du site disent « hors playoffs, NBA Cup comprise » et
restent justes dans les deux cas.

### Les crons s'arrêtent après 60 jours sans activité

GitHub désactive les workflows planifiés d'un dépôt public après 60 jours sans
activité (aucun commit). Le workflow ne commite rien, donc pendant une longue période
sans modification du site, `/ce-soir/` cesserait d'être actualisé. Pour l'éviter :
faire au moins un commit tous les deux mois (une page actualisée suffit), et si
GitHub a déjà désactivé le workflow, le réactiver dans l'onglet Actions (« Enable
workflow »). GitHub prévient par e-mail avant de le désactiver.
