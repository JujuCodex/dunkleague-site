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
par `_scripts/build.mjs` (Node 20 ou plus, aucune dépendance, rien à installer).
Le HTML produit est écrit directement à la racine du dépôt, que GitHub Pages sert
tel quel : on commite les sources **et** les pages générées.

```
node _scripts/build.mjs            # contrôle, puis écrit les pages, sitemap.xml et 404.html
node _scripts/build.mjs --check    # contrôle seulement, n'écrit rien
node _scripts/build.mjs --prune    # supprime aussi les pages générées dont la source a disparu
node _scripts/build.mjs --hash "expression"   # empreinte à ajouter au lexique
```

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
