# ⌘ Focus — Dashboard de productivité macOS

Application macOS native (Tauri 2) pour avoir une vision globale de ta productivité :
agenda Google Calendar, tickets Notion, to-do list avec priorités, timer Pomodoro et notes rapides.
Tout est stocké localement dans `~/.focus-app/` avec export JSON natif.

---

## Structure du projet

```
focus-app/
├── src/
│   ├── index.html          ← Interface (HTML + CSS)
│   └── main.js             ← Logique frontend (APIs Tauri + Google + Notion)
├── src-tauri/
│   ├── src/
│   │   └── main.rs         ← Backend Rust (stockage fichier, commandes)
│   ├── Cargo.toml          ← Dépendances Rust
│   ├── tauri.conf.json     ← Configuration Tauri (fenêtre, bundle, CSP)
│   └── entitlements.plist  ← Permissions macOS (réseau, fichiers, notifs)
├── package.json
└── README.md
```

---

## Installation — étape par étape

### 1. Prérequis système

**Xcode Command Line Tools** (si pas déjà installé) :
```bash
xcode-select --install
```

**Rust** (via rustup) :
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Vérifier :
```bash
rustc --version   # doit afficher rustc 1.75+
cargo --version
```

**Node.js** (v18+) — si pas installé, utilise [nvm](https://github.com/nvm-sh/nvm) :
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20
```

---

### 2. Installer les dépendances

Dans le dossier `focus-app/` :
```bash
npm install
```

Cela installe la CLI Tauri et les plugins JS.

---

### 3. Lancer en mode développement

```bash
npm run dev
```

Tauri compile le backend Rust (environ 2 minutes la première fois, beaucoup plus rapide ensuite)
puis ouvre la fenêtre de l'app avec rechargement automatique.

---

### 4. Compiler l'app finale (.app)

```bash
npm run build
```

Le bundle est configuré sur `"targets": ["app"]` : la compilation génère donc
uniquement le `.app` (pas de `.dmg`), dans :
```
src-tauri/target/release/bundle/macos/Focus.app
```

> Pour aussi générer un `.dmg`, passe `targets` à `["app", "dmg"]` dans
> `src-tauri/tauri.conf.json`, ou lance `npm run build -- --bundles dmg`.

> **Note :** Sans certificat Apple Developer (99$/an), macOS affichera un avertissement
> "développeur non identifié". Pour contourner : clic droit sur l'app → Ouvrir, ou :
> ```bash
> xattr -cr /Applications/Focus.app
> ```

---

## Configuration des APIs

Lance l'app et clique sur **"Connecter"** dans la barre du haut.

### Google Calendar

1. Va sur [Google Cloud Console](https://console.cloud.google.com)
2. Crée un projet (ou sélectionne un existant)
3. Active l'API : **APIs & Services → Enable APIs → Google Calendar API**
4. Crée une clé API : **Credentials → Create Credentials → API Key**
5. (Recommandé) Restreins la clé à l'API Calendar et à ton IP
6. Dans l'app : colle la clé et l'ID d'agenda (`primary` pour le principal)

### Notion

1. Va sur [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens)
2. Ouvre l'onglet **Jetons d'accès personnels**
3. **Créer un jeton** → donne un nom → sélectionne ton workspace → Enregistrer
4. Copie le **jeton personnel** (`ntn_...`)
5. Copie l'ID de la DB depuis l'URL :
   `https://notion.so/Mon-espace/`**`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`**`?v=...`
6. Dans l'app : colle le jeton et l'ID

---

## Données locales

Tout est stocké dans `~/.focus-app/` :

| Fichier | Contenu |
|---------|---------|
| `config.json` | Clés API (Google, Notion) |
| `todos.json` | Tes tâches |
| `notes.json` | Notes rapides |
| `pomo.json` | Stats Pomodoro |
| `cal_cache.json` | Cache agenda (5 min) |
| `notion_cache.json` | Cache tickets (5 min) |

Pour réinitialiser complètement :
```bash
rm -rf ~/.focus-app/
```

---

## Export

Le bouton **Export** ouvre la boîte de dialogue macOS "Enregistrer sous" et génère
un fichier `focus-export-YYYY-MM-DD.json` contenant toutes tes données.

---

## Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| `⌘S` | Sauvegarder les notes |
| `Entrée` | Ajouter une tâche (dans le champ to-do) |

---

## Fonctionnalités

- **Agenda Google Calendar** — événements des 7 prochains jours, cache 5 min
- **Tickets Notion** — connexion directe API, filtre par statut, tri par date
- **To-do list** — priorités (🔴🟡🟢), persistance locale, compteur
- **Pomodoro** — 25/5/15 min, stats du jour et total, notifications système natives
- **Notes rapides** — sauvegarde automatique sur ⌘S
- **Export JSON** — boîte de dialogue macOS native
- **Sync manuelle** — bouton Sync pour rafraîchir les données en temps réel

---

## Personnalisation

### Changer la durée Pomodoro

Dans `src/main.js`, ligne ~130 :
```js
const POMO_TIMES = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
//                         ↑ minutes   ↑ minutes       ↑ minutes
```

### Changer la plage de l'agenda

Dans `src/main.js`, dans `fetchCalendar()` :
```js
const timeMax = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
//                                       ↑ changer 7 pour le nombre de jours
```

### Ajouter un module

1. Ajoute un panneau HTML dans `src/index.html`
2. Ajoute la logique dans `src/main.js`
3. Si besoin d'accès système → ajoute une commande Rust dans `src-tauri/src/main.rs`

---

## Technologies

- [Tauri 2](https://tauri.app) — framework app native (Rust + WebView)
- [Rust](https://www.rust-lang.org) — backend natif, stockage fichier
- HTML / CSS / JS vanilla — frontend léger, aucune dépendance
- [Google Calendar API v3](https://developers.google.com/calendar)
- [Notion API v1](https://developers.notion.com)

---

*Taille de l'app compilée : ~4–6 Mo. RAM au repos : ~40 Mo.*
