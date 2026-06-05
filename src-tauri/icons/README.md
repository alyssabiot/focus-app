# Focus Planner — icônes (piste « Mire »)

Jeu d'icônes prêt pour Tauri, généré depuis le master `app-icon.png` (1024×1024).

## Où les déposer
Copiez le **contenu** de ce dossier dans `src-tauri/icons/` de focus-app :

- `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png` → icônes desktop
- `StoreLogo.png`, `Square*Logo.png` → tuiles Windows
- `android/mipmap-*/…` → à copier dans `src-tauri/gen/android/app/src/main/res/`
- `app-icon.png` → le master source (à garder)

## Régénérer .ico et .icns (formats binaires Windows/macOS)
Ces deux conteneurs ne peuvent pas être fournis en PNG. Une seule commande
les régénère (ainsi que toutes les tailles) à partir du master :

```bash
npm run tauri icon app-icons/app-icon.png
# ou : npx @tauri-apps/cli icon app-icons/app-icon.png
```

Astuce : si vous lancez cette commande, vous n'avez besoin de copier QUE
`app-icon.png` — Tauri (re)crée tout le dossier `icons/` correctement,
y compris `icon.ico`, `icon.icns` et les mipmaps Android adaptatives.

## Couleurs
Dégradé corail `#f6b187 → #e6824f`, emblème blanc. Coins en squircle (rayon 23 %).
