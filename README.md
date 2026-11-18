# P02 — Carte GPS et stations-service (France)

Application web **100 % statique** (aucun serveur, aucun build, aucune clé d'API) qui combine :

1. **Un système GPS** : calcul d'itinéraire, navigation « tour par tour » avec caméra 3D de suivi, limitations de vitesse, stops et feux, étapes, options « éviter péages / autoroutes », et un mode simulation pour tester sans bouger.
2. **Une recherche de stations-service** : toutes les stations de France avec leurs prix réels, filtrables par carburant et par prix, et, pendant la navigation, les 5 stations qui font perdre le moins de temps sur le trajet.

L'application est publiée avec GitHub Pages (dépôt `Titouan66/P02`, branche `main`, racine) et utilisée surtout sur téléphone. Interface, commentaires et noms de variables sont **en français**.

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
| `style.css` | Styles de l'interface (menus, bandeaux, interrupteurs, marqueurs de prix). |
| `fleche.svg` | Icône du véhicule pendant la navigation (orientée vers le haut). |
| `serveur.py` | Serveur de développement local. |

Pas de bibliothèque hormis MapLibre. JavaScript natif, pas de modules : tout passe par des scripts classiques et des variables globales.

## Services externes (appelés directement par le navigateur)

| Service | Utilisation |
|---|---|
| OpenFreeMap (`tiles.openfreemap.org`) | Tuiles vectorielles de la carte (schéma OpenMapTiles). Le style est défini dans `main.js` (palette `COULEURS`). |
| Valhalla, serveur public OSM (`valhalla1.openstreetmap.de`) | `/route` : itinéraire et manœuvres (avec péages/autoroutes à éviter). `/trace_attributes` : limitations de vitesse et feux. `/sources_to_targets` : matrice de temps pour mesurer les détours vers les stations. |
| Overpass (`overpass-api.de` + 2 miroirs) | Panneaux stop près du trajet. Serveurs souvent saturés : en cas d'échec, les stops ne s'affichent pas, sans bloquer le reste. |
| Nominatim (OSM) | Géocodage d'une adresse saisie pour l'itinéraire. |
| Base Adresse Nationale (`data.geopf.fr/geocodage`) | Géocodage inverse (adresse d'un point cliqué) et recherche de ville, code postal ou adresse pour les stations. |
| data.economie.gouv.fr | Jeu de données « prix des carburants en France, flux instantané v2 ». |

Aucune clé n'est nécessaire. Ces services publics ont des quotas : à ménager si on ajoute des appels.

## Fonctionnalités : système GPS (`main.js`)

- **Carte** MapLibre centrée sur Paris, avec contrôles de zoom et de rotation.
- **Départ / arrivée** : saisie d'une adresse, saisie de coordonnées `lat, lng`, ou clic sur la carte. Après un clic, l'adresse est retrouvée par géocodage inverse (ignorée si elle est à plus de 250 m). Les réponses périmées sont écartées (compteur `requetesAdresse`).
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

Dans `main.js`, la constante `GPS_REEL` vaut **`false`** (« MODE TEST »). Tant qu'elle est fausse :

- la géolocalisation du navigateur n'est **pas** utilisée pendant la navigation, et la « position actuelle » est le point de départ saisi ;
- le bouton « ⌖ Utiliser ma position » du menu GPS est masqué.

Pour utiliser le **vrai GPS** de l'appareil, par exemple sur téléphone, passer `GPS_REEL` à `true`. Le code de géolocalisation (`watchPosition`, gestion des refus et des erreurs) est déjà écrit.

## Fonctionnalités : stations-service (`carburant.js`)

Ce module est issu d'un projet précédent (« P01 ») et a été intégré à la carte de P02.

- **Chargement** : au démarrage, toutes les stations de France (~10 000, ~1 Mo compressé) sont téléchargées en une fois puis filtrées localement. Les prix sont rechargés toutes les 10 minutes. Les stations sont **harmonisées** par `harmoniser()` : id, coordonnées, adresse, prix et date de mise à jour par carburant.
- **Carburants** : SP95, SP98, Gazole, E10, E85, GPL (le champ de l'API est `gplc_*`, voir `CHAMPS_API`).
- **Affichage** : marqueurs HTML avec le prix (posés sur la carte sans toucher au style). On n'affiche que les **50 stations les plus proches du centre de la carte** parmi celles visibles, et **aucune sous le zoom 11**.
- **Filtre de prix** : curseur « Prix max » dont les bornes sont les percentiles 1 % et 99 % sur toute la France, pour écarter les prix aberrants.
- **Recherche d'un lieu** : ville, code postal, département ou adresse (Base Adresse Nationale), ou bouton 📍 pour se localiser. Un menu liste les stations trouvées.
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
