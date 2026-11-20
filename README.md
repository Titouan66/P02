# P02 — Carte GPS et stations-service (France)

Application web **100 % statique** (aucun serveur, aucun build, aucune clé d'API) qui combine :

1. **Un système GPS** : calcul d'itinéraire, navigation « tour par tour » avec caméra 3D de suivi, limitations de vitesse, stops et feux, étapes, options « éviter péages / autoroutes », et un mode simulation pour tester sans bouger.
2. **Une recherche de stations-service** : toutes les stations de France avec leurs prix réels, filtrables par carburant et par prix, et, pendant la navigation, les 5 stations qui font perdre le moins de temps sur le trajet.

L'application est publiée avec GitHub Pages (dépôt `Titouan66/P02`, branche `main`, racine) et utilisée surtout sur téléphone. Interface, commentaires et noms de variables sont **en français**.

Sur téléphone, **la page ne se zoome jamais, seule la carte le fait** : les boutons et les menus restent en place. Plusieurs réglages y contribuent :

- `index.html` : la balise viewport contient `user-scalable=no` ;
- `style.css` : `touch-action` sur la page et les boutons, et des champs en 16 px sur écran tactile (sinon l'iPhone zoome quand on touche un champ) ;
- `main.js` : les gestes `gesture*` de Safari sont bloqués.

## Lancer en local

```bash
python3 serveur.py 8000   # puis ouvrir http://localhost:8000
```

`serveur.py` est un simple serveur de fichiers statiques avec l'en-tête `Cache-Control: no-store` (pratique en développement). N'importe quel serveur statique convient. Une config de lancement existe dans `.claude/launch.json` (ignorée par git).

**Déploiement** : un `git push` sur `main` republie le site (GitHub Pages, 1 à 2 minutes). Le HTTPS de GitHub Pages est indispensable, car la géolocalisation du navigateur est bloquée en HTTP.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Tout le HTML : carte, menus (GPS, carburant), bandeaux de navigation, commandes de simulation. Charge MapLibre GL JS 4.7.1 depuis unpkg, puis `main.js`, puis `carburant.js` (**cet ordre compte**). |
| `main.js` (~1 700 lignes) | Carte, itinéraire, navigation, simulation, limitations/stops/feux, instructions de manœuvre. |
| `carburant.js` (~770 lignes) | Stations-service. S'exécute dans une IIFE **après** `main.js` et réutilise ses globales (`map`, `definirPoint`, `calculerTrajet`, `points`, etc.). |
| `lieux.js` | Points d'intérêt : commerces, restaurants, santé, services, hébergement, parkings. Même principe que `carburant.js` : une IIFE chargée en dernier, qui réutilise les globales de `main.js`. |
| `style.css` | Styles de l'interface (menus, bandeaux, interrupteurs, marqueurs de prix). |
| `fleche.svg` | Icône du véhicule pendant la navigation (orientée vers le haut). |
| `serveur.py` | Serveur de développement local. |

Pas de bibliothèque hormis MapLibre. JavaScript natif, pas de modules : tout passe par des scripts classiques et des variables globales.

## Services externes (appelés directement par le navigateur)

| Service | Utilisation |
|---|---|
| OpenFreeMap (`tiles.openfreemap.org`) | Tuiles vectorielles de la carte (schéma OpenMapTiles) et polices des noms de villes (`/fonts`). Le style est défini dans `main.js` (palette `COULEURS`). |
| Valhalla, serveur public OSM (`valhalla1.openstreetmap.de`) | `/route` : itinéraire et manœuvres (avec péages/autoroutes à éviter). `/trace_attributes` : limitations de vitesse et feux. `/sources_to_targets` : matrice de temps pour mesurer les détours vers les stations. |
| Overpass (`overpass-api.de` + 2 miroirs) | Panneaux stop près du trajet, et détails d'un lieu touché (adresse, horaires, téléphone, site). Serveurs souvent saturés ou lents (jusqu'à ~25 s) : en cas d'échec, l'information manque, sans bloquer le reste. |
| Nominatim (OSM) | Géocodage d'une adresse saisie pour l'itinéraire. Détails d'un lieu touché (`lookup` : horaires, téléphone, site). Limite : 1 requête par seconde. |
| Photon (`photon.komoot.io`) | Recherche de lieux et d'adresses du bandeau du bas, classée par proximité. |
| Base Adresse Nationale (`data.geopf.fr/geocodage`) | Géocodage inverse (adresse d'un point cliqué) et recherche de ville, code postal ou adresse pour les stations. |
| data.economie.gouv.fr | Jeu de données « prix des carburants en France, flux instantané v2 ». |

Aucune clé n'est nécessaire. Ces services publics ont des quotas : à ménager si on ajoute des appels.

## Fonctionnalités : système GPS (`main.js`)

- **Carte** MapLibre centrée sur Paris, avec contrôles de zoom et de rotation.
  - En dessous du zoom 13 (`ZOOM_BATIMENTS`), les bâtiments ne s'affichent pas. La carte montre à la place les **zones urbaines en gris plus foncé** (couche `urbain`) et les **noms des villes** (couche `noms-villes`, en français si possible, grandes villes prioritaires). Les deux s'effacent en fondu entre les zooms 12,5 et 13.
- **Parcours du bouton « GPS »** (pensé pour le téléphone : la carte reste visible). Le code se trouve dans la section « Interface du GPS » de `main.js` : `ouvrirGps`, `ouvrirSelection`, `afficherApercu`. Les états sont `etatGps` (`ferme`, `selection`, `apercu`) et les classes `selection`, `apercu`, `navigation` et `detail` sur `<body>`.
  1. Un **bandeau en bas** fait choisir la **destination** (l'arrivée). De gauche à droite : un champ d'adresse (validé par la touche Entrée), le bouton ⌖ (position actuelle) et le bouton 📍 (le prochain toucher sur la carte place le point). Un bandeau identique fait ensuite choisir le **départ**. L'ordre est fixé dans `lieuAChoisir`. Le ✕ annule.
  2. **Aperçu** : la carte se recadre sur tout le trajet. Le bandeau du bas affiche la distance, la durée et l'heure d'arrivée, avec « ▶ Départ » à la place de « Arrêter ». À sa gauche, « › Détail » ouvre le menu complet : champs, étapes, onglet « Éviter », simulation, Calculer / Effacer.
  3. « + Ajouter une étape » ouvre le même bandeau pour choisir l'étape.
  4. « Arrêter » ramène à l'aperçu. Re-toucher « GPS » range tout, mais le trajet reste sur la carte.
  - Les messages (recherche en cours, erreurs) s'affichent dans une bulle sous les boutons du haut (`#gps-message`). On la ferme en la touchant.
- **Départ / arrivée dans le menu détaillé** : saisie d'une adresse, saisie de coordonnées `lat, lng`, ou clic sur la carte quand le menu est ouvert. Après un clic, l'adresse est retrouvée par géocodage inverse (ignorée si elle est à plus de 250 m). Les réponses périmées sont écartées (compteur `requetesAdresse`).
- **Étapes** : jusqu'à 8 (`MAX_ETAPES`), via « + Ajouter une étape ». Les lieux (départ, étapes, arrivée) se réordonnent par glisser-déposer avec la poignée « ≡ » (ou au clavier avec les flèches).
- **Onglet « Éviter »** : interrupteurs péages et autoroutes, transmis à Valhalla.
- **Itinéraire** : tracé en bleu, durée et distance, polyligne décodée (`decoderPolyline6`). Boutons Calculer et Effacer.
- **Navigation (« ▶ Démarrer »)** :
  - Caméra inclinée à 60° derrière le véhicule, orientée dans le sens de marche. Le zoom est de 17 et le véhicule est placé dans le bas de l'écran (constantes `ZOOM_NAVIGATION`, `INCLINAISON_NAVIGATION`, `DECALAGE_VEHICULE`).
  - Mouvement fluide : lissage de la position et du cap, extrapolation à l'estime pendant 3 s maximum sans nouveau point GPS, délai de réaction de la caméra aux changements de cap. La caméra boucle sur `requestAnimationFrame` (`boucleCamera`).
  - Toucher la carte met la caméra en pause, puis elle revient au suivi après 5 s d'inactivité.
  - **Recalcul automatique en cas d'erreur de route** (`horsTrajet`, constantes en tête de la section navigation), au plus toutes les 5 s :
    - immédiatement à plus de 80 m du trajet ;
    - sur 2 positions de suite : à plus de 35 m en s'éloignant, ou à plus de 15 m en s'éloignant avec un cap à plus de 40° de celui de la route (mauvaise rue, mauvaise sortie), ou avec un cap opposé à la route (demi-tour, trajet pris à l'envers). Les critères de cap ne s'appliquent qu'au-dessus de ~7 km/h.
    - Le nouvel itinéraire part dans le sens de marche (cap transmis à Valhalla, à ± 45°), plutôt que par un demi-tour sur place. Sans route possible dans ce sens, on réessaie sans le cap.
  - Arrivée détectée à moins de 25 m.
  - **Bandeau bas** : distance restante, durée, heure d'arrivée, limitation de vitesse en cours, bouton « Arrêter ».
  - **Bandeau haut** : distance avant la prochaine manœuvre, instruction, et **schéma SVG** de la manœuvre ou de l'intersection (`schemaManoeuvre`, `svgIntersection`). Les manœuvres non directionnelles sont ignorées (`MANOEUVRES_IGNOREES`).
  - **Limitations de vitesse, feux et stops** affichés le long du trajet (Valhalla pour les limitations et les feux, Overpass pour les stops).
  - Les étapes déjà dépassées ne sont pas reprises lors d'un recalcul.
- **Mode simulation** (interrupteur « Simuler le déplacement ») : une voiture virtuelle suit le trajet, à 90 % de la limite de vitesse du tronçon (50 km/h par défaut) et plus lentement avant les virages. Elle envoie une position par seconde à `surPosition()`, comme un vrai GPS. Commandes : pause et vitesse ×1, ×2, ×5, ×10. Elle sert à régler la caméra, les instructions, les étapes et les stations sans se déplacer.

### Point d'attention : `GPS_REEL`

Dans `main.js`, la constante `GPS_REEL` vaut **`true`** : la navigation suit le **vrai GPS** de l'appareil (`watchPosition`). Si le champ Départ est vide, le départ est la position GPS. Le bouton « ⌖ Utiliser ma position » du menu GPS est disponible.

Le **mode simulation** reste utilisable : si « Simuler le déplacement » est coché au démarrage, la voiture virtuelle remplace le GPS et part du point de départ saisi.

Pour revenir à un **MODE TEST** sans géolocalisation, passer `GPS_REEL` à `false`. La « position actuelle » est alors le point de départ saisi, et le bouton « ⌖ Utiliser ma position » est masqué.

La géolocalisation exige une page en HTTPS (GitHub Pages) ou servie depuis `localhost`. Sur téléphone, il faut donc tester la version publiée.

## Fonctionnalités : lieux (`lieux.js`)

- **Affichage** : dès le zoom 15 (`ZOOM_LIEUX`), on affiche les lieux de la couche `poi` des tuiles OpenFreeMap (nom, type, position). Chacun a une pastille colorée selon sa catégorie (`CATEGORIES`) :
  - alimentation 🛒 en vert ;
  - restauration 🍴 en orange ;
  - commerces 🛍 en rose ;
  - santé ✚ en rouge ;
  - services ℹ en violet ;
  - hébergement 🛏 en bleu-vert ;
  - parkings P en gris.

  Les noms s'affichent dès le zoom 16. Quand deux lieux se chevauchent, le plus important (`rank`) passe en priorité. La table `SOUS_CLASSES` choisit les types affichés et leur nom en français.
- **Toucher un lieu** ouvre une bulle :
  - tout de suite : le nom et le type ;
  - en moins d'une seconde : l'adresse la plus proche, donnée par la Base Adresse Nationale ;
  - en 1 à 2 secondes, les données OpenStreetMap : l'adresse exacte (si elle est renseignée), les horaires traduits en français, le téléphone (lien d'appel) et le site web.
- **Comment on retrouve le lieu dans OpenStreetMap** : l'identifiant d'un lieu dans les tuiles vaut numéro OSM × 10 + type (1 = nœud, 2 = chemin, 3 = relation).
  - On interroge d'abord **Nominatim** (`lookup` avec `extratags`), qui répond en environ 1 s.
  - En secours, **Overpass** : les 3 serveurs en même temps, la première réponse l'emporte, abandon après 30 s. Ces serveurs sont souvent saturés.
  - Les réponses sont gardées en cache.
- **Bandeau de recherche** (en bas, quand le GPS est fermé) : on tape un texte puis on valide avec Entrée.
  - D'abord les lieux déjà chargés sur la carte, trouvés par leur nom (« Lidl ») ou leur type (« boulangerie »), du plus proche au plus loin.
  - Puis **Photon** (recherche OpenStreetMap de komoot), classé par proximité avec le centre de la carte. Il trouve aussi les adresses, les rues et les villes.
  - Si le texte est un type, la liste donne jusqu'à 8 lieux proches ; sinon, 4 au plus, et Photon complète.
  - Toucher un résultat centre la carte dessus et ouvre sa bulle. Toucher la carte range la liste.
- **Menu « ☰ »** (à droite du bandeau) : une ligne par type de lieu, avec un interrupteur pour l'afficher ou le masquer sur la carte. Le choix est retenu sur l'appareil (`localStorage`, clé `p02-types-lieux`) ; tous les types sont affichés par défaut.
- **Boutons** : « 🧭 Y aller » fait du lieu la destination. « ➕ Ajouter au trajet » l'ajoute comme étape, à la bonne place, quand un trajet existe.
- Pendant le choix d'un point sur la carte (📍), ou quand le menu détaillé du GPS est ouvert, toucher un lieu place le point au lieu d'ouvrir la bulle.

## Fonctionnalités : stations-service (`carburant.js`)

Ce module est issu d'un projet précédent (« P01 ») et a été intégré à la carte de P02.

- **Chargement** : au démarrage, toutes les stations de France (~10 000, ~1 Mo compressé) sont téléchargées en une fois puis filtrées localement. Les prix sont rechargés toutes les 10 minutes. Les stations sont **harmonisées** par `harmoniser()` : id, coordonnées, adresse, prix et date de mise à jour par carburant.
- **Carburants** : SP95, SP98, Gazole, E10, E85, GPL (le champ de l'API est `gplc_*`, voir `CHAMPS_API`).
- **Affichage** : marqueurs HTML avec le prix (posés sur la carte sans toucher au style). Les bulles s'affichent **à partir du zoom 9** (`ZOOM_MIN`). Au plus 50 bulles, les plus proches du centre de la carte, et jamais deux bulles qui se chevauchent : la plus proche du centre l'emporte (`sansChevauchement`). La liste du menu donne les 50 stations les plus proches du centre.
- **Filtre de prix** : curseur « Prix max » dont les bornes sont les percentiles 1 % et 99 % sur toute la France, pour écarter les prix aberrants.
- **Recherche d'un lieu** : ville, code postal, département ou adresse (Base Adresse Nationale), ou bouton 📍 pour se localiser. La liste des stations trouvées est repliée par défaut, pour garder la carte visible : le bouton « › Afficher la liste » la déplie. Les bulles de prix restent sur la carte dans les deux cas.
- **Bulle d'information** d'une station : nom, adresse, prix, date de relevé. Hors navigation, un bouton « 🧭 Y aller » en fait la destination (`allerA`), et si une arrivée est déjà définie, « ➕ Ajouter au trajet » l'insère comme étape. Depuis la liste « sur le trajet », la bulle affiche le détour et ne propose que l'ajout comme étape, à la bonne place (`ajouterAuTrajet`), avec recalcul de l'itinéraire.
- **Pendant la navigation** (bouton « ⛽ Stations ») : les **5 stations qui font perdre le moins de temps**.
  1. Présélection locale : stations devant le véhicule, à moins de 5 km du trajet restant et dans les 100 km à venir. On garde les 20 plus proches de la route.
  2. Mesure réelle du détour avec Valhalla (matrice de temps et de distances, par lots de 5 pour respecter la limite de 100 cases) : détour = (point d'avant → station) + (station → point d'après) − (point d'avant → point d'après).
  3. Classement par temps perdu, puis affichage avec le détour en minutes et en km.
  Le choix du carburant se fait dans ce panneau, et un bouton ↻ actualise la liste.
- Un seul menu est ouvert à la fois : ouvrir le menu GPS range le menu carburant, et inversement.

## Conventions et conseils pour modifier le code

- Les constantes de réglage (caméra, seuils, délais, nombre de stations…) sont en tête de section, avec des commentaires qui expliquent leur effet. Commencer par elles pour ajuster le comportement.
- `carburant.js` dépend des globales de `main.js` : garder l'ordre des `<script>` dans `index.html`.
- Pas de tests automatisés ni de build. Vérifier à la main dans le navigateur, avec le mode simulation pour la navigation.
- Les appels réseau échouent parfois (serveurs publics) : conserver le comportement dégradé existant (message d'erreur, ou fonction qui reste facultative comme les stops).
