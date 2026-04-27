

# Salle d'Immersion 3D Viewer
> [!NOTE]
> Ce projet est un fork du travail original de Djansma : [github.com/djansma/open3dviewer](https://github.com/djansma/open3dviewer)

Visualiseur web 3D pour fichiers .glb, .obj et .ply développé par l'équipe **Animation Numérique et Innovante & Low-Tech (ANI & Low-Tech)**, en partenariat avec le **Learning Centre Claude Oytana** (Besançon, France).

## Présentation du projet

Ce projet a été créé pour rendre la "Salle d'Immersion" plus ludique et interactive, suite aux demandes des enseignants et chercheurs. L'objectif est de fournir une application web compatible VR pour visualiser et manipuler des objets 3D à des fins pédagogiques et de recherche.

## Fonctionnalités

- Visualisation et interaction avec des modèles 3D (.glb, .obj, .ply) directement dans le navigateur (Chrome, Edge, Firefox, etc.)
- Support VR pour une expérience immersive (casques Oculus, HTC Vive, etc.)
- Contrôles clavier et souris pour la navigation
- Contrôles tactiles pour les appareils mobiles
- Activation/désactivation des structures individuellement ou en groupe

## Contrôles

**Appareils tactiles :**
- Glisser pour faire pivoter
- Glisser à deux doigts pour déplacer (pan)
- Taper pour sélectionner
- Pincer pour zoomer

**Souris/Clavier :**
- Clic gauche et glisser pour faire pivoter
- Molette pour zoomer
- Clic droit et glisser pour déplacer (pan)
- Clic gauche pour sélectionner, double-clic pour masquer
- Flèches du clavier pour tourner
- \+ / - pour zoomer

## Utilisation

Téléchargez ou clonez le dossier `open3dviewer` et hébergez-le sur un serveur web. Pour charger un modèle, utilisez une URL comme :

```
http://localhost:8000/?model=overview-demo
```

Vous pouvez aussi utiliser des paramètres d'URL optionnels :
- `subset` pour afficher un sous-ensemble de structures au démarrage : `?model=overview-demo&subset=lessbonesnomuscle`
- `export=on` pour exporter les noms des parents et structures sélectionnés (pratique pour Blender) : `?model=overview-demo&subset=lessbonesnomuscle&export=on`

L'ordre des paramètres n'a pas d'importance. Certains modèles spéciaux peuvent cloner automatiquement certaines structures de droite à gauche dans le visualiseur.

## Lancer le projet

Vous pouvez utiliser un serveur web simple. Si Python est installé, lancez cette commande dans le dossier du projet :

```bash
python3 -m http.server 8000
```

Puis ouvrez votre navigateur à l'adresse `http://localhost:8000/?model=overview-demo`.

### VR/HTTPS

Pour utiliser le visualiseur dans un casque VR, une URL HTTPS est nécessaire. Utilisez [ngrok](https://ngrok.com/) pour créer un tunnel sécurisé vers votre localhost (un compte gratuit suffit) :

```bash
ngrok http 8000
```

## Crédits

- Développé par : [Gaël Röthlin](https://github.com/moonlight58), Stagiaire à Animation Numérique et Innovante & Low-Tech (ANI & Low-Tech)
- En partenariat avec : Learning Centre Claude Oytana, Besançon, France
- Fork du projet original de Djansma : [github.com/djansma/open3dviewer](https://github.com/djansma/open3dviewer)

Ce projet est fourni "en l'état" sous licence GPL 3.0.