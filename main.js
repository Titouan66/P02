// Coordonnées au format [longitude, latitude]
const POSITION = [2.3522, 48.8566]; // Paris

// Palette
const COULEURS = {
  fond: "#e9e9e6",
  herbe: "#a8d5a2",
  foret: "#3f7d4e",
  batiment: "#a6a6a6",
  petiteRoute: "#ffffff",
  autoroute: "#4a4a4a",
  eau: "#cfe3f1",
};

// Style vectoriel minimal (schéma OpenMapTiles, tuiles OpenFreeMap)
const style = {
  version: 8,
  sources: {
    openmaptiles: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
      attribution:
        '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Données © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: "fond", type: "background", paint: { "background-color": COULEURS.fond } },

    // Eau (pour garder la Seine lisible ; supprimer cette couche pour la retirer)
    {
      id: "eau",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: { "fill-color": COULEURS.eau },
    },

    // Herbe : prairies + parcs et jardins
    {
      id: "herbe-landcover",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "grass"],
      paint: { "fill-color": COULEURS.herbe },
    },
    {
      id: "herbe-parcs",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: ["in", ["get", "class"], ["literal", ["park", "garden", "playground", "pitch", "cemetery"]]],
      paint: { "fill-color": COULEURS.herbe },
    },

    // Forêt
    {
      id: "foret",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": COULEURS.foret },
    },

    // Bâtiments
    {
      id: "batiments",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 13,
      paint: { "fill-color": COULEURS.batiment },
    },

    // Petites routes (blanc)
    {
      id: "petites-routes",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: [
        "in",
        ["get", "class"],
        ["literal", ["primary", "secondary", "tertiary", "minor", "service", "street"]],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": COULEURS.petiteRoute,
        "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 0.5, 14, 2, 18, 12],
      },
    },

    // Autoroutes (rouge), dessinées par-dessus
    {
      id: "autoroutes",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": COULEURS.autoroute,
        "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 6, 0.8, 14, 3.5, 18, 16],
      },
    },
  ],
};

const map = new maplibregl.Map({
  container: "map",
  style,
  center: POSITION,
  zoom: 12,
});

// Contrôles de navigation (zoom, rotation)
map.addControl(new maplibregl.NavigationControl(), "top-right");

// ---------------------------------------------------------------
// Itinéraire : point de départ -> point d'arrivée
// ---------------------------------------------------------------
const COULEUR_TRAJET = "#1d4ed8"; // bleu

const el = {
  depart: document.getElementById("depart"),
  arrivee: document.getElementById("arrivee"),
  resultat: document.getElementById("resultat"),
};

// État : { lngLat: [lng, lat], marqueur } ou null
const points = { depart: null, arrivee: null };

// Étapes intermédiaires (entre le départ et l'arrivée) : types "etape1", "etape2"…
// ordreEtapes donne leur ordre sur le trajet ; chacune a sa ligne dans le menu (el[type])
// et son point (points[type], avec passee = true une fois dépassée en navigation).
// Couleurs des lieux : dégradé du vert clair (départ) au vert foncé (arrivée),
// les étapes prenant les nuances intermédiaires selon leur place.
const VERT_CLAIR = [116, 224, 138];
const VERT_FONCE = [20, 83, 45];
const MAX_ETAPES = 8;
const ordreEtapes = [];
let compteurEtapes = 0;

// Couche du trajet (ajoutée une fois le style chargé)
map.on("load", () => {
  map.addSource("trajet", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "trajet-contour",
    type: "line",
    source: "trajet",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "trajet",
    type: "line",
    source: "trajet",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COULEUR_TRAJET, "line-width": 5 },
  });

  // Panneaux rencontrés sur le trajet (stops, feux)
  map.addImage("stop", iconeStop(), { pixelRatio: 2 });
  map.addImage("feu", iconeFeu(), { pixelRatio: 2 });
  map.addSource("signaux", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "signaux",
    type: "symbol",
    source: "signaux",
    minzoom: 12,
    layout: {
      "icon-image": ["get", "type"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.55, 16, 1],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
});

function message(texte, erreur = false) {
  el.resultat.textContent = texte;
  el.resultat.classList.toggle("erreur", erreur);
}

function formatCoords([lng, lat]) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// --- Adresse d'un point (géocodage inverse, Base Adresse Nationale) ---
// Un point placé sur la carte (clic, marqueur déplacé, ma position) s'affiche d'abord en coordonnées,
// puis le champ prend l'adresse la plus proche dès qu'elle est trouvée. Le point, lui, garde ses
// coordonnées exactes : seule l'étiquette du champ change.
const URL_ADRESSE_INVERSE = "https://data.geopf.fr/geocodage/reverse/";
const DISTANCE_ADRESSE_MAX_M = 250; // au-delà, l'adresse trouvée est trop loin pour être affichée
const requetesAdresse = {}; // type -> numéro de la dernière demande (ignore les réponses périmées)

const estCoords = (texte) => /^\s*-?\d+(?:\.\d+)?\s*[,;]\s*-?\d+(?:\.\d+)?\s*$/.test(texte);

async function chercherAdresse(type, lngLat, numero) {
  try {
    const url = `${URL_ADRESSE_INVERSE}?lon=${lngLat[0]}&lat=${lngLat[1]}&limit=1`;
    const reponse = await fetch(url);
    if (!reponse.ok) return;
    const proprietes = (await reponse.json()).features?.[0]?.properties;
    if (!proprietes?.label || proprietes.distance > DISTANCE_ADRESSE_MAX_M) return;
    // Le point a pu être déplacé, retiré ou renommé à la main pendant la recherche
    if (requetesAdresse[type] !== numero || !points[type] || !el[type]?.dataset.place) return;
    el[type].value = proprietes.label;
  } catch {
    // service indisponible : le champ garde simplement les coordonnées
  }
}

// Montre les coordonnées dans le champ, puis remplace par l'adresse quand elle arrive
function afficherPointDansChamp(type, lngLat) {
  el[type].value = formatCoords(lngLat);
  el[type].dataset.place = "1";
  chercherAdresse(type, lngLat, (requetesAdresse[type] = (requetesAdresse[type] ?? 0) + 1));
}

// Place (ou déplace) le marqueur de départ / d'arrivée
function definirPoint(type, lngLat, texte) {
  const champ = el[type];
  if (points[type]) {
    points[type].marqueur.setLngLat(lngLat);
    points[type].lngLat = lngLat;
  } else {
    const marqueur = new maplibregl.Marker({
      color: couleurLieu(type),
      draggable: true,
    })
      .setLngLat(lngLat)
      .addTo(map);
    // Un clic sur le marqueur ne doit pas placer un nouveau point
    marqueur.getElement().addEventListener("click", (ev) => ev.stopPropagation());
    marqueur.on("dragend", () => {
      const { lng, lat } = marqueur.getLngLat();
      points[type].lngLat = [lng, lat];
      afficherPointDansChamp(type, [lng, lat]);
      calculerTrajet();
    });
    points[type] = { lngLat, marqueur };
    majCouleursLieux();
  }
  if (texte === undefined || estCoords(texte)) {
    afficherPointDansChamp(type, lngLat); // coordonnées, puis adresse
  } else {
    requetesAdresse[type] = (requetesAdresse[type] ?? 0) + 1; // annule une recherche d'adresse en cours
    champ.value = texte;
    champ.dataset.place = "1"; // le point correspond au contenu du champ
  }
}

// Couleur d'un lieu : sa place parmi (départ, étapes…, arrivée) donne sa nuance de vert
function couleurLieu(type) {
  const lieux = ["depart", ...ordreEtapes, "arrivee"];
  const i = Math.max(0, lieux.indexOf(type));
  const t = lieux.length > 1 ? i / (lieux.length - 1) : 0;
  const c = VERT_CLAIR.map((v, k) => Math.round(v + (VERT_FONCE[k] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Applique le dégradé aux pastilles du menu et aux marqueurs de la carte
// (à rappeler dès que le nombre ou l'ordre des lieux change)
function majCouleursLieux() {
  for (const type of ["depart", ...ordreEtapes, "arrivee"]) {
    const couleur = couleurLieu(type);
    const pastille = el[type].closest("label").querySelector(".pastille");
    if (pastille) pastille.style.background = couleur;
    // Le corps du marqueur est le groupe SVG qui n'est ni noir (ombre) ni blanc (point central)
    const groupe = [...(points[type]?.marqueur.getElement().querySelectorAll("svg g[fill]") ?? [])].find(
      (g) => !["#000000", "#FFFFFF"].includes(g.getAttribute("fill").toUpperCase())
    );
    groupe?.setAttribute("fill", couleur);
  }
}

function retirerPoint(type) {
  if (points[type]) points[type].marqueur.remove();
  points[type] = null;
  requetesAdresse[type] = (requetesAdresse[type] ?? 0) + 1;
  el[type].value = "";
  delete el[type].dataset.place;
}

// Taper dans un champ invalide le point existant (il sera re-géocodé)
for (const type of ["depart", "arrivee"]) {
  el[type].addEventListener("input", () => delete el[type].dataset.place);
}

// --- Étapes : ajout (bouton « + » sous l'arrivée), retrait, ordre ---
// Crée la ligne d'une nouvelle étape à la position `index` de la liste et renvoie son type
function creerEtape(index = ordreEtapes.length) {
  const type = `etape${++compteurEtapes}`;
  const ligne = document.createElement("label");
  ligne.className = "champ etape";
  ligne.dataset.type = type;
  ligne.innerHTML =
    '<span class="poignee" role="button" tabindex="0" title="Glisser pour changer l\'ordre de l\'étape" ' +
    'aria-label="Déplacer l\'étape (glisser, ou flèches haut / bas)">≡</span>' +
    '<span class="pastille etape"></span>' +
    '<input type="text" placeholder="Étape (adresse ou clic sur la carte)" />' +
    '<button type="button" class="retirer-etape" title="Retirer cette étape">✕</button>';
  const champ = ligne.querySelector("input");
  el[type] = champ;
  points[type] = null;
  const avant = el[ordreEtapes[index]]?.closest("label") ?? el.arrivee.closest("label");
  avant.before(ligne);
  ordreEtapes.splice(index, 0, type);
  champ.addEventListener("input", () => delete champ.dataset.place);
  champ.addEventListener("focus", () => activer(type));
  ligne.querySelector(".retirer-etape").addEventListener("click", () => retirerEtape(type));
  activerPoignee(ligne.querySelector(".poignee"));
  majCouleursLieux();
  return type;
}

// --- Réordonner les lieux (départ, étapes, arrivée) avec la poignée « ≡ » ---
// Les lignes du menu sont des emplacements fixes : la 1re est toujours le départ, la dernière
// l'arrivée, celles du milieu des étapes. Glisser une ligne change donc le RÔLE des lieux
// (par ex. une étape glissée tout en haut devient le départ), pas la couleur des emplacements.
const lignesLieux = () => [...document.querySelectorAll("#onglet-itineraire > label.champ")];

// Contenu d'un emplacement : texte du champ + point sur la carte
function lireLieu(type) {
  return {
    texte: el[type].value,
    place: Boolean(el[type].dataset.place),
    lngLat: points[type] ? [...points[type].lngLat] : null,
  };
}

function ecrireLieu(type, lieu) {
  const champ = el[type];
  if (lieu.lngLat) {
    definirPoint(type, lieu.lngLat, lieu.texte || undefined); // crée ou déplace le marqueur
  } else {
    if (points[type]) points[type].marqueur.remove();
    points[type] = null;
    champ.value = lieu.texte;
  }
  if (lieu.place) champ.dataset.place = "1";
  else delete champ.dataset.place;
}

// Après un glissé : lit le nouvel ordre des lignes, redistribue les lieux entre les emplacements,
// remet les lignes à leur place habituelle puis recalcule le trajet. suivi : lieu dont on garde le focus.
function appliquerOrdreLieux(suivi) {
  const visuel = lignesLieux().map((l) => l.dataset.type);
  const emplacements = ["depart", ...ordreEtapes, "arrivee"];

  // Les lignes retrouvent leur position habituelle
  const conteneur = document.getElementById("onglet-itineraire");
  let precedente = null;
  for (const type of emplacements) {
    const ligne = el[type].closest("label");
    if (precedente) precedente.after(ligne);
    else conteneur.prepend(ligne);
    precedente = ligne;
  }

  if (visuel.join() !== emplacements.join()) {
    const lieux = Object.fromEntries(emplacements.map((t) => [t, lireLieu(t)]));
    visuel.forEach((ancien, i) => ecrireLieu(emplacements[i], lieux[ancien]));
    majCouleursLieux();
    calculerTrajet();
  }
  if (suivi) el[emplacements[visuel.indexOf(suivi)]].closest("label").querySelector(".poignee").focus();
}

// Poignée « ≡ » à gauche d'une ligne : on l'attrape à la souris (ou au doigt), la ligne suit le
// curseur et les autres s'écartent en direct ; l'ordre est appliqué au lâcher.
// Au clavier : flèches haut / bas sur la poignée.
function activerPoignee(poignee) {
  const ligne = poignee.closest("label");

  // Un clic sur la poignée ne doit pas donner le focus au champ de la ligne
  poignee.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  poignee.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const rects = lignesLieux().map((l) => l.getBoundingClientRect());
    const hautListe = Math.min(...rects.map((r) => r.top));
    const basListe = Math.max(...rects.map((r) => r.bottom));
    const prise = e.clientY - ligne.getBoundingClientRect().top; // où on a attrapé la ligne

    ligne.classList.add("deplacee");
    document.body.classList.add("glisse-lieu");
    // Garde les événements même si le curseur sort du menu ou de la fenêtre
    try {
      document.body.setPointerCapture(e.pointerId);
    } catch {
      /* pas grave : les écouteurs sur document suffisent */
    }
    const bloquer = (ev) => ev.preventDefault(); // pas de sélection de texte ni de glisser natif
    document.addEventListener("selectstart", bloquer);
    document.addEventListener("dragstart", bloquer);

    const bouger = (ev) => {
      const hauteur = ligne.offsetHeight;
      const haut = Math.max(hautListe, Math.min(basListe - hauteur, ev.clientY - prise));
      const centre = haut + hauteur / 2;

      // Les autres lignes s'écartent : la nôtre se place avant la première dont le milieu est plus bas
      const autres = lignesLieux().filter((l) => l !== ligne);
      const apres = autres.find((l) => {
        const r = l.getBoundingClientRect();
        return centre < r.top + r.height / 2;
      });
      if (apres) {
        if (ligne.nextElementSibling !== apres) apres.before(ligne);
      } else if (autres.length && ligne.previousElementSibling !== autres.at(-1)) {
        autres.at(-1).after(ligne);
      }

      // La ligne suit le curseur (décalage par rapport à sa place dans la liste)
      ligne.style.transform = "none";
      ligne.style.transform = `translateY(${haut - ligne.getBoundingClientRect().top}px)`;
    };

    const fin = () => {
      document.removeEventListener("pointermove", bouger);
      document.removeEventListener("pointerup", fin);
      document.removeEventListener("pointercancel", fin);
      document.removeEventListener("selectstart", bloquer);
      document.removeEventListener("dragstart", bloquer);
      ligne.style.transform = "";
      ligne.classList.remove("deplacee");
      document.body.classList.remove("glisse-lieu");
      appliquerOrdreLieux();
    };
    document.addEventListener("pointermove", bouger);
    document.addEventListener("pointerup", fin);
    document.addEventListener("pointercancel", fin);
  });

  poignee.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const voisine = e.key === "ArrowUp" ? ligne.previousElementSibling : ligne.nextElementSibling;
    if (!voisine?.matches("label.champ")) return;
    if (e.key === "ArrowUp") voisine.before(ligne);
    else voisine.after(ligne);
    appliquerOrdreLieux(ligne.dataset.type);
  });
}

// Départ et arrivée ont leur poignée dans la page ; les étapes reçoivent la leur à leur création
for (const type of ["depart", "arrivee"]) {
  const ligne = el[type].closest("label");
  ligne.dataset.type = type;
  activerPoignee(ligne.querySelector(".poignee"));
}
majCouleursLieux();

function retirerEtape(type, { recalculer = true } = {}) {
  if (!el[type]) return;
  retirerPoint(type);
  el[type].closest("label").remove();
  delete el[type];
  delete points[type];
  ordreEtapes.splice(ordreEtapes.indexOf(type), 1);
  majCouleursLieux();
  if (actif === type) activer(points.depart ? "arrivee" : "depart");
  if (recalculer) calculerTrajet();
}

// Géocode les étapes saisies ; une ligne vide est simplement ignorée
async function resoudreEtapes() {
  for (const type of [...ordreEtapes]) {
    if (!el[type].value.trim()) retirerPoint(type);
    else await resoudre(type);
  }
}

// Étape dépassée en navigation : elle n'est plus reprise lors d'un recalcul
function etapePassee(type) {
  if (!points[type] || points[type].passee) return;
  points[type].passee = true;
  points[type].marqueur.getElement().classList.add("etape-passee");
}

function reinitialiserEtapes() {
  for (const type of ordreEtapes) {
    if (!points[type]) continue;
    points[type].passee = false;
    points[type].marqueur.getElement().classList.remove("etape-passee");
  }
}

// Position d'une nouvelle étape dans la liste, selon sa distance `along` (m) le long du trajet
function indexEtape(along) {
  const cumuls = new Map((routeActive?.etapes ?? []).map((e) => [e.type, e.cumul]));
  for (let i = 0; i < ordreEtapes.length; i++) {
    const c = cumuls.get(ordreEtapes[i]);
    if (c !== undefined && c > along) return i;
  }
  return ordreEtapes.length;
}

// Ajoute un lieu comme étape (à la bonne place sur le trajet) et recalcule le trajet.
// En navigation, le calcul repart de la position actuelle. Renvoie false en cas d'échec.
async function ajouterEtapeAuTrajet(lngLat, texte, along = Infinity) {
  if (ordreEtapes.length >= MAX_ETAPES) {
    message(`Maximum ${MAX_ETAPES} étapes`, true);
    return false;
  }
  const type = creerEtape(indexEtape(along));
  definirPoint(type, lngLat, texte);

  if (!nav) {
    await calculerTrajet();
    return true;
  }
  const origine = nav.derniere ?? points.depart?.lngLat;
  const ok = origine && (await calculerTrajet({ origine, ajuster: false }));
  if (!ok) {
    retirerEtape(type, { recalculer: false });
    return false;
  }
  if (nav) surPosition({ coords: { longitude: origine[0], latitude: origine[1], heading: null }, synthetique: true });
  return true;
}

// Géocodage d'une adresse avec Nominatim (OpenStreetMap)
async function geocoder(texte) {
  // Accepte aussi des coordonnées "lat, lng"
  const m = texte.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lngLat: [parseFloat(m[2]), parseFloat(m[1])], nom: null };

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
    encodeURIComponent(texte);
  const reponse = await fetch(url, { headers: { "Accept-Language": "fr" } });
  if (!reponse.ok) throw new Error("Recherche d'adresse indisponible");
  const resultats = await reponse.json();
  if (!resultats.length) throw new Error(`Adresse introuvable : « ${texte} »`);
  return {
    lngLat: [parseFloat(resultats[0].lon), parseFloat(resultats[0].lat)],
    nom: resultats[0].display_name,
  };
}

// Résout un champ en point (utilise le point déjà placé si le champ n'a pas changé)
async function resoudre(type) {
  const champ = el[type];
  const texte = champ.value.trim();
  if (!texte) throw new Error(type === "depart" ? "Indique un départ" : "Indique une arrivée");
  if (champ.dataset.place && points[type]) return;
  const { lngLat, nom } = await geocoder(texte);
  definirPoint(type, lngLat, nom ? texte : undefined);
}

function formatDuree(secondes) {
  const min = Math.round(secondes / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

function formatDistance(metres) {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

// Onglets du menu (Itinéraire / Éviter) et interrupteurs
function afficherOnglet(nom) {
  for (const n of ["itineraire", "eviter"]) {
    const actif = n === nom;
    document.getElementById(`onglet-${n}`).hidden = !actif;
    document.getElementById(`onglet-btn-${n}`).setAttribute("aria-selected", String(actif));
  }
}
document.getElementById("onglet-btn-itineraire").addEventListener("click", () => afficherOnglet("itineraire"));
document.getElementById("onglet-btn-eviter").addEventListener("click", () => afficherOnglet("eviter"));

// Chaque interrupteur met à jour l'option et relance le calcul du trajet
for (const [cle, id] of [["peages", "eviter-peages"], ["autoroutes", "eviter-autoroutes"]]) {
  document.getElementById(id).addEventListener("change", (e) => {
    eviter[cle] = e.target.checked;
    calculerTrajet();
  });
}

// Calcul du trajet en voiture avec Valhalla (serveur public d'OpenStreetMap)
// Route courante, gardée en mémoire pour la navigation :
// { coords, cumul (distance cumulée en m à chaque sommet), total (m), duree (s) }
let routeActive = null;
let derniereRequete = 0;

// Options de l'onglet « Éviter »
const eviter = { peages: false, autoroutes: false };

// Décode une polyligne encodée (précision 6) en [[lng, lat], ...]
function decoderPolyline6(texte) {
  const coords = [];
  let i = 0, lat = 0, lng = 0;
  while (i < texte.length) {
    for (const axe of ["lat", "lng"]) {
      let decalage = 0, resultat = 0, octet;
      do {
        octet = texte.charCodeAt(i++) - 63;
        resultat |= (octet & 0x1f) << decalage;
        decalage += 5;
      } while (octet >= 0x20);
      const delta = resultat & 1 ? ~(resultat >> 1) : resultat >> 1;
      if (axe === "lat") lat += delta;
      else lng += delta;
    }
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

// origine : point de départ du calcul (par défaut le marqueur de départ)
// cap : sens de marche au départ (degrés), pour un recalcul en roulant ; null = indifférent
// ajuster : recadrer la carte et afficher le résumé dans le menu
// Passe par les étapes dans l'ordre (sauf celles déjà dépassées). Renvoie true si le trajet est à jour.
async function calculerTrajet({ origine, cap = null, ajuster = true } = {}) {
  if (!points.arrivee || (!origine && !points.depart)) return false;
  if (ajuster) message("Calcul en cours…");
  const [a, b] = [origine ?? points.depart.lngLat, points.arrivee.lngLat];
  const etapesUtilisees = ordreEtapes.filter((t) => points[t] && !points[t].passee);
  const lieux = [a, ...etapesUtilisees.map((t) => points[t].lngLat), b];
  const requete = ++derniereRequete; // ignore les réponses périmées (bascules rapides)

  // Valhalla (serveur public d'OpenStreetMap) : gère péages / autoroutes à éviter
  const optionsAuto = {};
  if (eviter.peages) optionsAuto.exclude_tolls = true;
  if (eviter.autoroutes) optionsAuto.use_highways = 0;
  const corps = {
    locations: lieux.map(([lon, lat]) => ({ lon, lat })),
    costing: "auto",
    costing_options: { auto: optionsAuto },
    directions_options: { units: "kilometers", language: "fr-FR" },
  };
  if (cap != null) Object.assign(corps.locations[0], { heading: Math.round(cap), heading_tolerance: TOLERANCE_CAP });

  try {
    const reponse = await fetch("https://valhalla1.openstreetmap.de/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
    const donnees = await reponse.json().catch(() => ({}));
    if (requete !== derniereRequete) return false;
    if (!reponse.ok || !donnees.trip) {
      // Aucune route dans notre sens de marche (impasse, cap imprécis…) : on réessaie sans le cap
      if (cap != null) return calculerTrajet({ origine, ajuster });
      throw new Error(
        reponse.status === 400
          ? "Aucun itinéraire trouvé avec ces options"
          : "Service d'itinéraire indisponible"
      );
    }
    const resume = donnees.trip.summary; // length en km, time en s
    const route = { distance: resume.length * 1000, duration: resume.time };
    // Un tronçon (leg) par segment entre deux lieux : on les met bout à bout.
    // Le dernier point d'un tronçon est le premier du suivant : on ne le garde qu'une fois.
    const legs = donnees.trip.legs;
    const coords = [];
    const decalages = []; // décalage des indices de chaque tronçon dans `coords`
    const fins = []; // indice du dernier point de chaque tronçon
    legs.forEach((leg, k) => {
      const pts = decoderPolyline6(leg.shape);
      decalages.push(k === 0 ? 0 : coords.length - 1);
      for (const p of k === 0 ? pts : pts.slice(1)) coords.push(p);
      fins.push(coords.length - 1);
    });
    map.getSource("trajet").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
    });

    const cumul = [0];
    for (let i = 1; i < coords.length; i++) {
      cumul.push(cumul[i - 1] + distanceM(coords[i - 1], coords[i]));
    }
    routeActive = { coords, cumul, total: cumul[cumul.length - 1] || 1, duree: route.duration };
    // Où se trouve chaque étape sur le trajet (fin de son tronçon)
    routeActive.etapes = etapesUtilisees.map((type, i) => ({ type, cumul: cumul[fins[i]] ?? routeActive.total }));
    routeActive.manoeuvres = legs.flatMap((leg, k) =>
      leg.maneuvers.map((m) => ({
        ...m,
        begin_shape_index: m.begin_shape_index + decalages[k],
        end_shape_index: m.end_shape_index + decalages[k],
        // l'arrivée d'un tronçon intermédiaire est une étape, pas la destination
        ...(k < legs.length - 1 && [4, 5, 6].includes(m.type)
          ? { instruction: "Vous arrivez à votre étape" }
          : {}),
      }))
    );
    // Recalcul en cours de route : l'ancienne progression ne vaut plus pour ce nouveau trajet
    if (origine && nav) {
      nav.parcouru = null;
      nav.segment = null;
    }
    // Limitations de vitesse, feux et stops : chargés en arrière-plan
    // (un appel par tronçon : le service refuse le tracé complet d'un trajet à étapes)
    chargerDetails(routeActive, legs.map((leg, k) => ({ shape: leg.shape, decalage: decalages[k] })));
    majInstruction();

    if (ajuster) {
      const bounds = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(a, a));
      map.fitBounds(bounds, {
        padding: { top: 60, bottom: 60, left: menuOuvert() ? 340 : 60, right: 60 },
        maxZoom: 16,
      });
      message(`${formatDistance(route.distance)} · ${formatDuree(route.duration)}`);
    }
    return true;
  } catch (e) {
    if (ajuster) {
      routeActive = null;
      map.getSource("trajet").setData({ type: "FeatureCollection", features: [] });
      map.getSource("signaux")?.setData({ type: "FeatureCollection", features: [] });
      message(e.message, true);
    }
    return false;
  }
}

function effacerTrajet() {
  routeActive = null;
  map.getSource("trajet")?.setData({ type: "FeatureCollection", features: [] });
  map.getSource("signaux")?.setData({ type: "FeatureCollection", features: [] });
}

// Formulaire : géocode les champs puis calcule le trajet
document.getElementById("panneau").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    message("Recherche des adresses…");
    await resoudre("depart");
    await resoudreEtapes();
    await resoudre("arrivee");
    await calculerTrajet();
  } catch (err) {
    message(err.message, true);
  }
});

// Bouton « Effacer »
document.getElementById("effacer").addEventListener("click", () => {
  arreterNavigation();
  retirerPoint("depart");
  retirerPoint("arrivee");
  for (const type of [...ordreEtapes]) retirerEtape(type, { recalculer: false });
  effacerTrajet();
  message("");
  activer("depart");
});

// Bouton « Ma position » : départ = position GPS de l'appareil
document.getElementById("ma-position").addEventListener("click", () => {
  if (!navigator.geolocation) return message("Géolocalisation non disponible", true);
  message("Localisation en cours…");
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      definirPoint("depart", [coords.longitude, coords.latitude]);
      message("");
      map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 14 });
      calculerTrajet();
    },
    () => message("Position refusée ou indisponible", true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// Champ « actif » : celui qui reçoit le prochain clic sur la carte.
// On l'active en cliquant dans le champ (ou sur 📍 pour l'arrivée).
let actif = "depart";

function activer(type) {
  actif = type;
  for (const t of ["depart", ...ordreEtapes, "arrivee"]) el[t].classList.toggle("actif", t === type);
}

// Bouton « GPS » : ouvre / range le menu d'itinéraire.
// Menu fermé : les points et le trajet restent affichés, mais la carte ne reçoit plus de pointage.
const panneau = document.getElementById("panneau");
const boutonGps = document.getElementById("bouton-gps");
const carte = document.getElementById("map");

function menuOuvert() {
  return !panneau.hidden;
}

boutonGps.addEventListener("click", () => {
  panneau.hidden = menuOuvert();
  boutonGps.setAttribute("aria-expanded", String(menuOuvert()));
  carte.classList.toggle("pointage", menuOuvert());
});

el.depart.addEventListener("focus", () => activer("depart"));
el.arrivee.addEventListener("focus", () => activer("arrivee"));
document.getElementById("pointer-arrivee").addEventListener("click", () => {
  activer("arrivee");
  el.arrivee.focus();
});
activer("depart");

// Bouton « + » sous l'arrivée : nouvelle ligne d'étape (juste avant l'arrivée)
document.getElementById("ajouter-etape").addEventListener("click", () => {
  if (ordreEtapes.length >= MAX_ETAPES) return message(`Maximum ${MAX_ETAPES} étapes`, true);
  const type = creerEtape();
  el[type].focus(); // le prochain clic sur la carte place cette étape
});

// Clic sur la carte : place le point du champ actif,
// puis passe automatiquement à l'arrivée (ou au départ) s'il est encore vide.
map.on("click", (e) => {
  if (!menuOuvert()) return;
  definirPoint(actif, [e.lngLat.lng, e.lngLat.lat]);
  const autre = actif === "arrivee" ? "depart" : "arrivee";
  if (!points[autre]) activer(autre);
  calculerTrajet();
});

// ---------------------------------------------------------------
// Navigation : bouton « Démarrer »
// ---------------------------------------------------------------
const ICONE_POSITION = "fleche.svg"; // à remplacer pour personnaliser l'icône (orientée vers le haut)
// MODE TEST : tant que GPS_REEL vaut false, la géolocalisation du navigateur n'est PAS utilisée.
// La « position actuelle » est alors le point de départ du menu GPS.
// Passer à true pour utiliser le vrai GPS de l'appareil.
const GPS_REEL = false;
if (!GPS_REEL) document.getElementById("ma-position").hidden = true;

const ZOOM_NAVIGATION = 17;

// Caméra de suivi : vue inclinée « derrière » le véhicule, orientée dans son sens de marche.
const INCLINAISON_NAVIGATION = 60; // degrés (0 = vue de dessus, 60 = maximum de MapLibre)
const DECALAGE_VEHICULE = 0.42;    // part haute de l'écran réservée à la route devant : le véhicule est dans le bas
const DELAI_CAMERA_MS = 700;       // délai avant que la caméra réagisse à un changement de cap (intersections…)
const LISSAGE_CAMERA_MS = 900;     // rotation douce : ~63 % du virage rattrapé en 0,9 s après le délai
const LISSAGE_CAP_VEHICULE_MS = 150;
const LISSAGE_POSITION_MS = 200;   // le véhicule et la caméra glissent vers la position estimée (absorbe les corrections GPS)
const EXTRAPOLATION_MAX_MS = 3000; // sans nouveau GPS, la voiture continue de rouler (à l'estime) pendant 3 s au plus
const ECART_ROUTE_EXTRAPOLATION_M = 30; // au-delà de cet écart on n'est plus « sur la route » : extrapolation en ligne droite
const ANTICIPATION_CAP_M = 8;      // le cap de la flèche est celui de la route 8 m devant la voiture
const PAUSE_CAMERA_MS = 5000;      // inactivité (sans toucher la carte) au bout de laquelle la caméra revient en mode suivi
const DUREE_RETOUR_MS = 900;       // durée du retour progressif vers la vue de suivi
const SEUIL_ARRIVEE_M = 25;    // en dessous, on considère être arrivé

// Détection d'une erreur de route (mauvaise rue, mauvaise sortie, demi-tour, contresens)
const SEUIL_HORS_ROUTE_M = 80;      // au-delà, on est hors trajet : recalcul immédiat
const ECART_SUSPECT_M = 35;         // au-delà, hors trajet si cela se confirme (voir CONFIRMATIONS_HORS_ROUTE)
const ELOIGNEMENT_MIN_M = 2;        // l'écart doit grandir d'au moins 2 m d'une position à l'autre (voir horsTrajet)
const ECART_DIVERGENCE_M = 15;      // à partir de cet écart, un cap qui diverge signale une mauvaise route…
const ANGLE_DIVERGENCE = 40;        // …s'il s'écarte de celui de la route d'au moins 40°
const ANGLE_CONTRESENS = 120;       // cap opposé à celui de la route : demi-tour ou trajet pris à l'envers
const VITESSE_MIN_CAP_MS = 2;       // en dessous (~7 km/h), le cap n'est pas fiable : on ne s'en sert pas
const CONFIRMATIONS_HORS_ROUTE = 2; // positions suspectes de suite avant de recalculer (filtre les sauts du GPS)
const DELAI_ENTRE_RECALCULS_MS = 5000; // ménage le serveur public si l'on reste hors trajet
const TOLERANCE_CAP = 45;           // le nouvel itinéraire part dans notre sens de marche, à ± 45°

const bandeau = document.getElementById("bandeau");
const elBandeau = {
  distance: document.getElementById("bandeau-distance"),
  temps: document.getElementById("bandeau-temps"),
  arrivee: document.getElementById("bandeau-arrivee"),
};

// { watchId, marqueur, derniere, cap, dernierRecalcul, recalcul } ou null
let nav = null;

function distanceM([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Cap (0-360°, 0 = nord) du point a vers le point b
function capEntre([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const dLng = (lng2 - lng1) * rad;
  const y = Math.sin(dLng) * Math.cos(lat2 * rad);
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLng);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

// Projette la position sur la route : distance parcourue le long du trajet + écart latéral (m)
// global : cherche sur tout le trajet (sinon on cherche d'abord près de la dernière progression,
// pour ne pas « sauter » sur un tronçon déjà fait ou à venir quand le trajet repasse au même endroit,
// par exemple pour aller à une étape puis revenir sur la route).
function progression(pos, global = false) {
  const { coords, cumul } = routeActive;
  const k = Math.cos((pos[1] * Math.PI) / 180);
  const versMetres = (p) => [(p[0] - pos[0]) * 111320 * k, (p[1] - pos[1]) * 110540];

  const chercher = (debut, fin) => {
    let meilleur = { ecart: Infinity, parcouru: 0, segment: debut };
    for (let i = debut; i < fin; i++) {
      const [ax, ay] = versMetres(coords[i]);
      const [bx, by] = versMetres(coords[i + 1]);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const ecart = Math.hypot(ax + t * dx, ay + t * dy);
      if (ecart < meilleur.ecart) {
        meilleur = { ecart, parcouru: cumul[i] + t * (cumul[i + 1] - cumul[i]), segment: i };
      }
    }
    return meilleur;
  };

  if (!global && nav?.parcouru != null) {
    let debut = nav.segment ?? 0;
    while (debut > 0 && cumul[debut] > nav.parcouru - 300) debut--;
    let fin = nav.segment ?? 0;
    while (fin < coords.length - 1 && cumul[fin] < nav.parcouru + 3000) fin++;
    const local = chercher(debut, fin);
    if (local.ecart <= SEUIL_HORS_ROUTE_M) return local;
  }
  return chercher(0, coords.length - 1);
}

function majBandeau(restantM, restantS) {
  elBandeau.distance.textContent = formatDistance(restantM);
  elBandeau.temps.textContent = formatDuree(Math.max(60, restantS));
  // Tant que le GPS ne répond plus, l'heure d'arrivée laisse la place au message d'alerte
  elBandeau.arrivee.textContent = nav?.signalPerdu
    ? "Signal perdu"
    : new Date(Date.now() + restantS * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// Erreur du GPS (pas de signal, délai dépassé…) : on prévient dans le bandeau
function surErreurGps() {
  if (!nav) return;
  nav.signalPerdu = true;
  elBandeau.arrivee.textContent = "Signal perdu";
}

function creerIcone() {
  const conteneur = document.createElement("div");
  conteneur.className = "position-actuelle";
  const img = new Image();
  img.src = ICONE_POSITION;
  img.alt = "Ma position";
  conteneur.append(img);
  return conteneur;
}

// Appelée à chaque nouvelle position GPS
// synthetique : position fabriquée par l'application (ex. recalcul du trajet), pas une vraie mesure :
// elle ne sert ni à estimer la vitesse ni de base à l'extrapolation.
function surPosition({ coords: c, synthetique = false }) {
  if (!nav) return;
  const pos = [c.longitude, c.latitude];
  const maintenant = performance.now();

  // Vitesse (m/s) : celle du GPS si elle existe, sinon déduite des deux dernières positions (≥ 0,2 s d'écart)
  if (!synthetique) {
    const ref = nav.refVitesse;
    if (!ref) {
      nav.refVitesse = { pos, t: maintenant };
    } else if (maintenant - ref.t >= 200) {
      const mesuree =
        c.speed != null && !Number.isNaN(c.speed)
          ? c.speed
          : distanceM(ref.pos, pos) / ((maintenant - ref.t) / 1000);
      nav.vitesse = nav.vitesse == null ? mesuree : nav.vitesse * 0.4 + mesuree * 0.6;
      nav.refVitesse = { pos, t: maintenant };
    }
    nav.fix = { t: maintenant }; // instant de la dernière position réelle : base de l'extrapolation
    // Une vraie position est arrivée : le signal est retrouvé (majBandeau remet l'heure d'arrivée)
    if (nav.signalPerdu) {
      nav.signalPerdu = false;
      elBandeau.arrivee.textContent = "–";
    }
  }
  const aBouge = !nav.derniere || distanceM(nav.derniere, pos) > 3;

  // Cap : celui du GPS s'il existe, sinon déduit du dernier déplacement
  if (c.heading != null && !Number.isNaN(c.heading)) nav.cap = c.heading;
  else if (nav.derniere && aBouge) nav.cap = capEntre(nav.derniere, pos);
  if (aBouge) nav.derniere = pos;

  nav.cible = pos; // dernière position connue ; la voiture est estimée au-delà (voir etatEstime)

  if (!routeActive) return;
  const { ecart, parcouru, segment } = progression(pos);
  const restantM = Math.max(0, routeActive.total - parcouru);
  const restantS = routeActive.duree * (restantM / routeActive.total);
  nav.segment = segment;
  nav.parcouru = parcouru;
  nav.ecart = ecart;
  // Étapes dépassées (ou atteintes) : on ne les reprendra pas en cas de recalcul
  for (const e of routeActive.etapes ?? []) {
    if (parcouru >= e.cumul - SEUIL_ARRIVEE_M) etapePassee(e.type);
  }
  majBandeau(restantM, restantS);
  majLimite();
  majInstruction();

  if (restantM < SEUIL_ARRIVEE_M) {
    navigator.geolocation.clearWatch(nav.watchId);
    elBandeau.temps.textContent = "Arrivé ✓";
    elBandeau.arrivee.textContent = "–";
    document.getElementById("bandeau-haut").hidden = true;
    return;
  }

  // Hors trajet : on recalcule depuis la position actuelle (seules les vraies positions comptent)
  if (synthetique) return;
  if (horsTrajet(ecart, parcouru) && !nav.recalcul && Date.now() - nav.dernierRecalcul > DELAI_ENTRE_RECALCULS_MS) {
    recalculerDepuis(pos);
  }
}

// Le véhicule a-t-il quitté le trajet ? Appelée à chaque vraie position.
// - très loin du trajet (> SEUIL_HORS_ROUTE_M) : oui, tout de suite ;
// - un peu à l'écart (> ECART_SUSPECT_M), ou cap qui s'écarte de la route (mauvaise rue, mauvaise sortie),
//   ou cap opposé à la route (demi-tour, trajet pris à l'envers, que l'écart seul ne voit jamais) :
//   oui si c'est le cas sur CONFIRMATIONS_HORS_ROUTE positions de suite.
// Pour l'écart, il faut aussi s'ÉLOIGNER du trajet : une vraie erreur de route éloigne de plus en plus,
// alors qu'un GPS imprécis (immeubles, tunnel…) donne un écart qui reste stable ou qui zigzague.
function horsTrajet(ecart, parcouru) {
  if (ecart > SEUIL_HORS_ROUTE_M) return true;
  const sEloigne = ecart > (nav.ecartPrecedent ?? Infinity) + ELOIGNEMENT_MIN_M;
  nav.ecartPrecedent = ecart;
  let suspect = sEloigne && ecart > ECART_SUSPECT_M;
  if (!suspect && (nav.vitesse ?? 0) >= VITESSE_MIN_CAP_MS) {
    // Sens de la route à notre hauteur (sur ~15 m, pour lisser les petits zigzags du tracé)
    const capRoute = capEntre(pointSurTrajet(routeActive, parcouru - 5), pointSurTrajet(routeActive, parcouru + 10));
    const ecartCap = Math.abs(normaliser(nav.cap - capRoute));
    suspect = ecartCap > ANGLE_CONTRESENS || (sEloigne && ecart > ECART_DIVERGENCE_M && ecartCap > ANGLE_DIVERGENCE);
  }
  nav.suspect = suspect ? (nav.suspect ?? 0) + 1 : 0;
  return nav.suspect >= CONFIRMATIONS_HORS_ROUTE;
}

// Nouvel itinéraire depuis `pos`. En roulant, il part dans notre sens de marche : Valhalla propose
// alors de continuer puis de faire demi-tour plus loin, plutôt qu'un demi-tour sur place.
function recalculerDepuis(pos) {
  nav.recalcul = true;
  nav.dernierRecalcul = Date.now();
  nav.suspect = 0;
  nav.ecartPrecedent = null; // l'écart repart de zéro sur le nouveau trajet
  const cap = (nav.vitesse ?? 0) >= VITESSE_MIN_CAP_MS ? nav.cap : null;
  calculerTrajet({ origine: pos, cap, ajuster: false })
    .then((ok) => {
      // Bandeau et instructions passent tout de suite au nouveau trajet, sans attendre la position suivante
      if (ok && nav) {
        surPosition({ coords: { longitude: nav.cible[0], latitude: nav.cible[1], heading: null }, synthetique: true });
      }
    })
    .finally(() => {
      if (nav) nav.recalcul = false;
    });
}

function positionActuelle() {
  return new Promise((ok, ko) =>
    navigator.geolocation.getCurrentPosition(ok, ko, { enableHighAccuracy: true, timeout: 10000 })
  );
}

let demarrageEnCours = false;

async function demarrer() {
  if (nav || demarrageEnCours) return; // évite deux navigations (et deux flèches) en parallèle
  demarrageEnCours = true;
  try {
    await lancerNavigation();
  } finally {
    demarrageEnCours = false;
  }
}

// ---------------------------------------------------------------
// Caméra de suivi
// ---------------------------------------------------------------
// Une boucle (à chaque image) fait glisser le véhicule vers la dernière position GPS et oriente la
// caméra dans son sens de marche, avec un DÉLAI de réaction (DELAI_CAMERA_MS) puis une rotation
// douce (LISSAGE_CAMERA_MS) : dans un virage ou à une intersection, la flèche tourne d'abord,
// la carte suit un instant après, comme une caméra tenue derrière la voiture.

// Angle ramené entre 0 et 360
const angle360 = (a) => ((a % 360) + 360) % 360;

// Fait tourner `courant` vers `cible` par le plus court chemin, d'une fraction k du chemin
function tournerVers(courant, cible, k) {
  const ecart = ((((cible - courant) % 360) + 540) % 360) - 180;
  return angle360(courant + ecart * k);
}

// Sens de la route au départ (point ~30 m plus loin)
function capDeLaRoute() {
  const { coords, cumul } = routeActive;
  let i = 1;
  while (i < coords.length - 1 && cumul[i] < 30) i++;
  return capEntre(coords[0], coords[i]);
}

function nouvelleCamera(pos, cap, pauseMs = 0) {
  const t = performance.now();
  return {
    pos: [...pos],
    bearing: cap,
    capMarqueur: cap,
    historique: [{ t, cap }], // caps récents : la caméra regarde celui d'il y a DELAI_CAMERA_MS
    dernier: t,
    pauseJusqua: t + pauseMs,
    maintenu: false,   // un doigt / la souris est posé sur la carte
    manuel: false,     // la caméra a été déplacée à la main : elle doit revenir en mode suivi
    enPause: pauseMs > 0,
    retourJusqua: 0,   // fin du retour progressif en cours
    rafId: null,
  };
}

// Marge haute de la vue de suivi : le véhicule est dans le bas de l'écran
const rembourrageNavigation = () => ({ top: Math.round(map.getContainer().clientHeight * DECALAGE_VEHICULE) });

// Suspend le suivi de la caméra pendant `ms` (par ex. quand l'utilisateur déplace la carte)
function pauseCamera(ms = PAUSE_CAMERA_MS) {
  if (!nav?.camera) return;
  nav.camera.manuel = true;
  nav.camera.pauseJusqua = Math.max(nav.camera.pauseJusqua, performance.now() + ms);
}

// Estime la voiture à l'instant t : depuis la dernière position GPS elle a continué à la vitesse mesurée.
// Sur la route, elle suit le tracé (elle prend donc les virages) et son cap est celui de la route juste
// devant elle ; sinon elle file droit dans le sens du dernier cap.
function etatEstime(t) {
  const secondes = nav.fix ? Math.min(EXTRAPOLATION_MAX_MS, t - nav.fix.t) / 1000 : 0;
  const vitesse = nav.vitesse ?? 0;
  const distance = vitesse * secondes;
  const r = routeActive;
  const surLaRoute = r && nav.parcouru != null && (nav.ecart ?? Infinity) <= ECART_ROUTE_EXTRAPOLATION_M;

  if (surLaRoute) {
    const s0 = nav.parcouru;
    const s1 = Math.min(r.total, s0 + distance);
    const p0 = pointSurTrajet(r, s0);
    const p1 = pointSurTrajet(r, s1);
    // On garde l'écart (bruit GPS) entre la position mesurée et la route : seule l'avancée est ajoutée
    const pos = [nav.cible[0] + (p1[0] - p0[0]), nav.cible[1] + (p1[1] - p0[1])];
    // À l'arrêt on garde le cap mesuré ; en roulant, le cap de la route (continu dans les courbes)
    const cap = vitesse > 1 && s1 < r.total - 1 ? capEntre(p1, pointSurTrajet(r, s1 + ANTICIPATION_CAP_M)) : nav.cap;
    return { pos, cap };
  }

  // Hors trajet : ligne droite dans le sens du cap
  const rad = Math.PI / 180;
  const dLat = (distance * Math.cos(nav.cap * rad)) / 110540;
  const dLng = (distance * Math.sin(nav.cap * rad)) / (111320 * Math.cos(nav.cible[1] * rad));
  return { pos: [nav.cible[0] + dLng, nav.cible[1] + dLat], cap: nav.cap };
}

function boucleCamera(t) {
  if (!nav?.camera) return;
  const cam = nav.camera;
  cam.rafId = requestAnimationFrame(boucleCamera);
  // Le lissage est exact quel que soit le pas : on ne plafonne que les très longues pauses (onglet masqué)
  const dt = Math.min(1000, t - cam.dernier);
  cam.dernier = t;
  if (dt <= 0) return;

  // Position et cap estimés à cet instant (extrapolation) : la voiture avance à chaque image,
  // pas seulement quand une nouvelle position GPS arrive
  const estime = etatEstime(t);
  const kp = 1 - Math.exp(-dt / LISSAGE_POSITION_MS);
  cam.pos = [cam.pos[0] + (estime.pos[0] - cam.pos[0]) * kp, cam.pos[1] + (estime.pos[1] - cam.pos[1]) * kp];
  cam.capMarqueur = tournerVers(cam.capMarqueur, estime.cap, 1 - Math.exp(-dt / LISSAGE_CAP_VEHICULE_MS));
  nav.marqueur.setLngLat(cam.pos).setRotation(cam.capMarqueur);

  // Cap de la caméra : celui du véhicule il y a DELAI_CAMERA_MS, rejoint en douceur
  cam.historique.push({ t, cap: estime.cap });
  while (cam.historique.length > 1 && cam.historique[1].t <= t - DELAI_CAMERA_MS) cam.historique.shift();
  // Carte manipulée à la main : on ne touche plus à la caméra (la flèche du véhicule continue d'avancer)
  if (cam.maintenu || t < cam.pauseJusqua) {
    cam.enPause = true;
    cam.bearing = map.getBearing();
    return;
  }
  // Fin de la pause : retour progressif vers la vue de suivi (centre, cap, zoom, inclinaison)
  if (cam.enPause && cam.manuel) {
    cam.manuel = false;
    cam.retourJusqua = t + DUREE_RETOUR_MS;
    map.easeTo({
      center: cam.pos,
      bearing: cam.historique[0].cap,
      zoom: ZOOM_NAVIGATION,
      pitch: INCLINAISON_NAVIGATION,
      padding: rembourrageNavigation(),
      duration: DUREE_RETOUR_MS,
    });
  }
  cam.enPause = false;
  if (t < cam.retourJusqua) {
    cam.bearing = map.getBearing(); // on laisse l'animation de retour se terminer
    return;
  }
  cam.bearing = tournerVers(cam.bearing, cam.historique[0].cap, 1 - Math.exp(-dt / LISSAGE_CAMERA_MS));
  map.jumpTo({ center: cam.pos, bearing: cam.bearing });
}

// Pendant la navigation on peut déplacer / zoomer / tourner la carte à la main :
// le suivi s'arrête dès qu'on la touche et revient PAUSE_CAMERA_MS après la dernière action.
const zoneCarte = map.getCanvasContainer();
zoneCarte.addEventListener("pointerdown", () => {
  if (!nav?.camera) return;
  nav.camera.maintenu = true;
  nav.camera.manuel = true;
});
const relacherCarte = () => {
  if (!nav?.camera?.maintenu) return;
  nav.camera.maintenu = false;
  pauseCamera(); // l'attente de PAUSE_CAMERA_MS démarre au relâchement
};
for (const evenement of ["pointerup", "pointercancel", "blur"]) window.addEventListener(evenement, relacherCarte);
zoneCarte.addEventListener("wheel", () => pauseCamera(), { passive: true });
// Mouvements dus à l'utilisateur (inertie après un glissé, clavier, boutons + / −…)
for (const evenement of ["dragstart", "zoomstart", "rotatestart", "pitchstart", "move"]) {
  map.on(evenement, (e) => {
    if (e.originalEvent) pauseCamera();
  });
}

// ---------------------------------------------------------------
// Simulation : une voiture virtuelle roule le long du trajet (essais sans vrai GPS)
// ---------------------------------------------------------------
// Elle envoie une position par seconde à surPosition(), comme un vrai GPS : on peut ainsi juger la
// caméra de suivi, ses délais aux intersections, les instructions, les étapes et les stations.
const VITESSES_SIMULATION = [1, 2, 5, 10]; // multiplicateurs de vitesse proposés
const elSim = {
  interrupteur: document.getElementById("simulation"),
  pause: document.getElementById("simulation-pause"),
  vitesse: document.getElementById("simulation-vitesse"),
};
let sim = null; // { minuteur, s (m parcourus sur le trajet), route, pause, multiplicateur } ou null

// Position [lng, lat] à la distance d (m) le long du trajet
function pointSurTrajet(r, d) {
  const { coords, cumul } = r;
  const dist = Math.max(0, Math.min(r.total, d));
  let bas = 0;
  let haut = cumul.length - 1;
  while (bas < haut) {
    const m = (bas + haut + 1) >> 1;
    if (cumul[m] <= dist) bas = m;
    else haut = m - 1;
  }
  if (bas >= coords.length - 1) return coords[coords.length - 1];
  const t = (dist - cumul[bas]) / (cumul[bas + 1] - cumul[bas] || 1);
  return [
    coords[bas][0] + t * (coords[bas + 1][0] - coords[bas][0]),
    coords[bas][1] + t * (coords[bas + 1][1] - coords[bas][1]),
  ];
}

function tickSimulation() {
  if (!nav || !sim) return arreterSimulation();
  if (sim.pause || !routeActive) return;
  const r = routeActive;
  // Trajet recalculé (nouvelle étape, sortie de route) : on repart de la progression actuelle
  if (sim.route !== r) {
    sim.route = r;
    sim.s = nav.parcouru ?? 0;
  }
  // Vitesse : 90 % de la limite du tronçon (50 km/h par défaut), réduite à l'approche d'un virage
  const segment = nav.segment ?? 0;
  const limite = r.limites?.find((l) => segment >= l.debut && segment < l.fin)?.limite ?? 50;
  let v = (Math.min(limite, 130) * 0.9) / 3.6; // m/s
  const virage = r.manoeuvres?.find((m) => m.begin_shape_index > segment && !MANOEUVRES_IGNOREES.has(m.type));
  if (virage) {
    const d = Math.max(0, r.cumul[virage.begin_shape_index] - sim.s);
    if (d < 60) v = Math.min(v, 5 + ((v - 5) * d) / 60);
  }
  sim.s = Math.min(r.total, sim.s + v * sim.multiplicateur); // un pas = 1 s de conduite
  const [longitude, latitude] = pointSurTrajet(r, sim.s);
  surPosition({ coords: { longitude, latitude, heading: null } });
  if (sim.s >= r.total - 1) arreterSimulation(); // arrivé
}

function majControlesSimulation() {
  elSim.pause.textContent = sim?.pause ? "▶" : "⏸";
  elSim.pause.title = sim?.pause ? "Reprendre" : "Mettre en pause";
  elSim.vitesse.textContent = `×${sim?.multiplicateur ?? 1}`;
}

function demarrerSimulation() {
  arreterSimulation();
  sim = { minuteur: setInterval(tickSimulation, 1000), s: 0, route: null, pause: false, multiplicateur: 1 };
  document.body.classList.add("simulation");
  majControlesSimulation();
}

function arreterSimulation() {
  if (sim) clearInterval(sim.minuteur);
  sim = null;
  document.body.classList.remove("simulation");
}

elSim.pause.addEventListener("click", () => {
  if (!sim) return;
  sim.pause = !sim.pause;
  if (sim.pause && nav) nav.vitesse = 0; // l'extrapolation s'arrête avec la voiture
  majControlesSimulation();
});
elSim.vitesse.addEventListener("click", () => {
  if (!sim) return;
  const i = VITESSES_SIMULATION.indexOf(sim.multiplicateur);
  sim.multiplicateur = VITESSES_SIMULATION[(i + 1) % VITESSES_SIMULATION.length];
  majControlesSimulation();
});

async function lancerNavigation() {
  const simule = elSim.interrupteur.checked; // voiture virtuelle : pas de GPS
  const reel = GPS_REEL && !simule;
  if (reel && !navigator.geolocation) return message("Géolocalisation non disponible", true);
  try {
    message(reel ? "Localisation en cours…" : "Démarrage…");
    await resoudre("arrivee");
    await resoudreEtapes();
    let p;
    if (reel) {
      try {
        p = await positionActuelle();
      } catch {
        throw new Error("Position refusée ou indisponible");
      }
      // Sans départ saisi, le départ est la position GPS
      if (!el.depart.value.trim()) {
        definirPoint("depart", [p.coords.longitude, p.coords.latitude]);
      } else {
        await resoudre("depart");
      }
    } else {
      // Mode test : la position actuelle est le point de départ
      await resoudre("depart");
      const [lng, lat] = points.depart.lngLat;
      p = { coords: { longitude: lng, latitude: lat, heading: null } };
    }
    await calculerTrajet({ ajuster: false });
    if (!routeActive) return message("Aucun itinéraire trouvé", true);

    const depart = [p.coords.longitude, p.coords.latitude];
    const cap0 = capDeLaRoute();
    nav = {
      marqueur: new maplibregl.Marker({
        element: creerIcone(),
        rotationAlignment: "map",
        pitchAlignment: "map",
      })
        .setLngLat(depart)
        .addTo(map),
      derniere: null,
      cap: cap0,
      cible: depart,
      // pause pendant le vol d'approche (flyTo ci-dessous), puis la boucle prend le relais
      camera: nouvelleCamera(depart, cap0, 1700),
      dernierRecalcul: 0,
      recalcul: false,
      watchId: null,
      signalPerdu: false, // vrai entre une erreur du GPS et la position suivante
    };
    message("");
    if (menuOuvert()) boutonGps.click(); // range le menu
    bandeau.hidden = false;
    document.body.classList.add("navigation");
    surPosition(p);
    map.flyTo({
      center: [p.coords.longitude, p.coords.latitude],
      zoom: ZOOM_NAVIGATION,
      pitch: INCLINAISON_NAVIGATION,
      bearing: cap0,
      padding: rembourrageNavigation(),
      duration: 1500,
    });
    nav.camera.rafId = requestAnimationFrame(boucleCamera);
    if (reel) {
      nav.watchId = navigator.geolocation.watchPosition(surPosition, surErreurGps, {
        enableHighAccuracy: true,
        maximumAge: 1000,
      });
    }
    if (simule) demarrerSimulation();
  } catch (e) {
    message(e.message, true);
  }
}

function arreterNavigation() {
  if (!nav) return;
  if (nav.watchId != null) navigator.geolocation.clearWatch(nav.watchId);
  cancelAnimationFrame(nav.camera.rafId);
  arreterSimulation();
  nav.marqueur.remove();
  nav = null;
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });
  reinitialiserEtapes();
  bandeau.hidden = true;
  document.getElementById("bandeau-haut").hidden = true;
  document.body.classList.remove("navigation");
}

document.getElementById("demarrer").addEventListener("click", demarrer);
document.getElementById("arreter").addEventListener("click", arreterNavigation);

// ---------------------------------------------------------------
// Détails du trajet : limitations de vitesse, feux et stops
// ---------------------------------------------------------------
// - Limitations et feux : Valhalla (trace_attributes), fiable.
// - Stops : Overpass (données OpenStreetMap). Serveurs publics parfois saturés :
//   s'ils ne répondent pas, les stops ne s'affichent simplement pas.
const SERVEURS_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// troncons : [{ shape (polyligne encodée d'un tronçon), decalage (indice de son 1er point dans route.coords) }]
function chargerDetails(route, troncons) {
  map.getSource("signaux")?.setData({ type: "FeatureCollection", features: [] });
  chargerLimitesEtFeux(route, troncons);
  chargerStops(route);
}

// Arêtes (routes) d'un tronçon, avec leurs indices ramenés à ceux de route.coords
async function aretesDuTroncon({ shape, decalage }) {
  const reponse = await fetch("https://valhalla1.openstreetmap.de/trace_attributes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encoded_polyline: shape,
      shape_match: "edge_walk",
      costing: "auto",
      filters: {
        attributes: [
          "edge.speed_limit",
          "node.intersecting_edge.begin_heading",
          "edge.begin_shape_index",
          "edge.end_shape_index",
          "edge.traffic_signal",
          "node.traffic_signal",
        ],
        action: "include",
      },
    }),
  });
  if (!reponse.ok) return [];
  const { edges = [] } = await reponse.json();
  return edges.map((e) => ({
    ...e,
    begin_shape_index: e.begin_shape_index + decalage,
    end_shape_index: e.end_shape_index + decalage,
  }));
}

async function chargerLimitesEtFeux(route, troncons) {
  try {
    // Un tronçon qui échoue n'empêche pas d'afficher les autres
    const edges = (await Promise.all(troncons.map((t) => aretesDuTroncon(t).catch(() => [])))).flat();
    if (!edges.length) return;
    if (route !== routeActive) return; // trajet changé entre-temps

    // Limitation par tronçon (indices dans route.coords)
    // Tronçons indexés par leur point d'arrivée : sert au schéma des intersections
    route.aretesParFin = new Map(edges.map((e) => [e.end_shape_index, e]));

    route.limites = edges
      .filter((e) => Number.isFinite(e.speed_limit) && e.speed_limit > 0 && e.speed_limit < 200)
      .map((e) => ({ debut: e.begin_shape_index, fin: e.end_shape_index, limite: e.speed_limit }));

    // Feux en fin de tronçon (doublons à moins de 20 m fusionnés)
    route.feux = [];
    for (const e of edges) {
      if (!(e.traffic_signal || e.end_node?.traffic_signal)) continue;
      const point = route.coords[e.end_shape_index];
      if (!point || route.feux.some((f) => distanceM(f, point) < 20)) continue;
      route.feux.push(point);
    }
    afficherPanneaux(route);
    majLimite();
    majInstruction(); // le schéma peut maintenant montrer les autres routes du carrefour
  } catch {
    // service indisponible : pas de limitation ni de feux affichés
  }
}

async function chargerStops(route) {
  // Points du trajet (échantillonnés) pour une recherche « à moins de 15 m du trajet »
  const n = route.coords.length;
  const pas = Math.max(1, Math.ceil(n / 800));
  const ligne = route.coords
    .filter((_, i) => i % pas === 0 || i === n - 1)
    .map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`)
    .join(",");
  const requete = `[out:json][timeout:25];node["highway"="stop"](around:15,${ligne});out;`;

  for (const url of SERVEURS_OVERPASS) {
    const controle = new AbortController();
    const minuteur = setTimeout(() => controle.abort(), 15000);
    try {
      const reponse = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: requete }),
        signal: controle.signal,
      });
      if (!reponse.ok) continue;
      const { elements = [] } = await reponse.json();
      if (route !== routeActive) return;
      route.stops = elements.map((e) => [e.lon, e.lat]);
      afficherPanneaux(route);
      return;
    } catch {
      // serveur suivant
    } finally {
      clearTimeout(minuteur);
    }
  }
  console.info("Stops non disponibles : aucun serveur Overpass n'a répondu.");
}

function afficherPanneaux(route) {
  if (route !== routeActive) return;
  const points = [
    ...(route.feux ?? []).map((c) => ({ c, type: "feu" })),
    ...(route.stops ?? []).map((c) => ({ c, type: "stop" })),
  ];
  map.getSource("signaux")?.setData({
    type: "FeatureCollection",
    features: points.map(({ c, type }) => ({
      type: "Feature",
      properties: { type },
      geometry: { type: "Point", coordinates: c },
    })),
  });
}

// Cercle rouge à gauche du bandeau : limitation du tronçon en cours (si connue)
function majLimite() {
  const elLimite = document.getElementById("bandeau-limite");
  let limite = null;
  if (nav && routeActive?.limites) {
    const i = nav.segment ?? 0;
    limite = routeActive.limites.find((l) => i >= l.debut && i < l.fin)?.limite ?? null;
  }
  elLimite.hidden = limite == null;
  if (limite != null) elLimite.textContent = limite;
}

// Icônes dessinées en canvas (taille x2 pour les écrans haute densité)
function iconeStop() {
  const t = 56;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = t;
  const g = canvas.getContext("2d");
  const r = t / 2 - 3;
  g.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    const x = t / 2 + r * Math.cos(a);
    const y = t / 2 + r * Math.sin(a);
    if (k) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
  g.fillStyle = "#d62828";
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = "#ffffff";
  g.stroke();
  g.fillStyle = "#ffffff";
  g.font = "bold 15px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("STOP", t / 2, t / 2 + 1);
  return g.getImageData(0, 0, t, t);
}

function iconeFeu() {
  const w = 34;
  const h = 70;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 8);
  g.fillStyle = "#222222";
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = "#ffffff";
  g.stroke();
  for (const [y, couleur] of [[16, "#ef4444"], [35, "#f59e0b"], [54, "#22c55e"]]) {
    g.beginPath();
    g.arc(w / 2, y, 8, 0, Math.PI * 2);
    g.fillStyle = couleur;
    g.fill();
  }
  return g.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------
// Bandeau du haut : prochain changement de direction + schéma
// ---------------------------------------------------------------
// Types de manœuvres Valhalla qui ne sont pas un changement de direction
// (0 aucune, 1-3 départ, 7 la route change de nom, 8 continuer, 27 sortie de rond-point
// déjà annoncée à l'entrée)
const MANOEUVRES_IGNOREES = new Set([0, 1, 2, 3, 7, 8, 27]);

function majInstruction() {
  const bandeauHaut = document.getElementById("bandeau-haut");
  if (!nav || !routeActive?.manoeuvres?.length) {
    bandeauHaut.hidden = true;
    return;
  }
  const segment = nav.segment ?? 0;
  const prochaine = routeActive.manoeuvres.find(
    (m) => m.begin_shape_index > segment && !MANOEUVRES_IGNOREES.has(m.type)
  );
  if (!prochaine) {
    bandeauHaut.hidden = true;
    return;
  }
  const distance = Math.max(0, routeActive.cumul[prochaine.begin_shape_index] - (nav.parcouru ?? 0));
  document.getElementById("prochaine-distance").textContent =
    distance < 1000 ? `${Math.round(distance / 10) * 10} m` : `${(distance / 1000).toFixed(1)} km`;
  document.getElementById("prochaine-instruction").textContent = prochaine.instruction.replace(/\.$/, "");
  document.getElementById("schema").innerHTML = schemaManoeuvre(prochaine);
  bandeauHaut.hidden = false;
}

// Cap moyen en arrivant au point b (sens -1) ou en le quittant (sens +1), sur ~20 m
function capAutour(coords, b, sens) {
  const p = coords[b];
  let j = b + sens;
  while (j > 0 && j < coords.length - 1 && distanceM(coords[j], p) < 20) j += sens;
  j = Math.max(0, Math.min(coords.length - 1, j));
  if (j === b) return null;
  return sens < 0 ? capEntre(coords[j], p) : capEntre(p, coords[j]);
}

// Angle ramené entre -180 et 180
const normaliser = (a) => ((((a % 360) + 540) % 360) - 180);

function schemaManoeuvre(m) {
  const { coords, manoeuvres, aretesParFin } = routeActive;
  const b = m.begin_shape_index;
  if ([4, 5, 6].includes(m.type)) return svgArrivee();
  if (m.type === 12) return svgDemiTour("droite");
  if (m.type === 13) return svgDemiTour("gauche");

  const entree = capAutour(coords, b, -1) ?? 0;

  if (m.type === 26) {
    // Rond-point : direction de sortie relative à l'entrée
    const sortie = manoeuvres.find((x) => x.type === 27 && x.begin_shape_index > b);
    const capSortie = sortie ? capAutour(coords, sortie.begin_shape_index, +1) : null;
    const rel = capSortie == null ? 0 : normaliser(capSortie - entree);
    return svgRondPoint(rel, m.roundabout_exit_count);
  }

  // Intersection : direction à prendre + autres routes du carrefour (si connues)
  const sortie = capAutour(coords, b, +1) ?? entree;
  const autres = (aretesParFin?.get(b)?.end_node?.intersecting_edges ?? []).map((x) =>
    normaliser(x.begin_heading - entree)
  );
  return svgIntersection(normaliser(sortie - entree), autres);
}

// --- Dessins SVG (72 x 72) : la route d'arrivée vient toujours du bas ---
const CX = 36;
const CY = 40;
const ROUTE_GRISE = 'stroke="rgba(255,255,255,0.35)" stroke-width="7" stroke-linecap="round" fill="none"';
const ROUTE_SUIVIE = 'stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"';

function pt(angle, l) {
  const a = (angle * Math.PI) / 180;
  return [(CX + l * Math.sin(a)).toFixed(1), (CY - l * Math.cos(a)).toFixed(1)];
}

function pointe(angle, l) {
  const a = (angle * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const bx = CX + ux * (l - 2);
  const by = CY + uy * (l - 2);
  const sommet = [CX + ux * (l + 9), CY + uy * (l + 9)];
  const g = [bx - uy * 8, by + ux * 8];
  const d = [bx + uy * 8, by - ux * 8];
  const f = (p) => p.map((v) => v.toFixed(1)).join(",");
  return `<polygon points="${f(sommet)} ${f(g)} ${f(d)}" fill="#ffffff"/>`;
}

function svg(contenu) {
  return `<svg viewBox="0 0 72 72" width="72" height="72">${contenu}</svg>`;
}

function svgIntersection(rel, autres) {
  const grises = autres
    .map((r) => {
      const [x, y] = pt(r, 34);
      return `<line x1="${CX}" y1="${CY}" x2="${x}" y2="${y}" ${ROUTE_GRISE}/>`;
    })
    .join("");
  const [x, y] = pt(rel, 20);
  return svg(
    `${grises}<path d="M${CX},70 L${CX},${CY} L${x},${y}" ${ROUTE_SUIVIE}/>${pointe(rel, 20)}`
  );
}

function svgRondPoint(rel, numero) {
  const R = 12;
  const e = Math.abs(rel) < 1 ? 1 : rel; // évite un arc nul (tout droit exactement)
  const [ex, ey] = pt(e, R);
  const [sx, sy] = pt(e, 21);
  // Sens de circulation en France : anti-horaire. Arc de l'entrée (bas) vers la sortie.
  const parcours = (((180 - e) % 360) + 360) % 360;
  const grandArc = parcours > 180 ? 1 : 0;
  return svg(
    `<circle cx="${CX}" cy="${CY}" r="${R}" ${ROUTE_GRISE}/>` +
      `<path d="M${CX},70 L${CX},${CY + R} A${R},${R} 0 ${grandArc} 0 ${ex},${ey} L${sx},${sy}" ${ROUTE_SUIVIE}/>` +
      pointe(e, 21) +
      (numero
        ? `<text x="${CX}" y="${CY + 4}" text-anchor="middle" font-size="11" font-weight="800" fill="#ffffff" font-family="system-ui, sans-serif">${Number(numero)}</text>`
        : "")
  );
}

function svgDemiTour(cote) {
  // Demi-tour à gauche : on monte à droite, on redescend à gauche (et inversement)
  const [xMontee, xDescente] = cote === "gauche" ? [46, 26] : [26, 46];
  const balayage = cote === "gauche" ? 0 : 1;
  return svg(
    `<path d="M${xMontee},70 L${xMontee},26 A10,10 0 0 ${balayage} ${xDescente},26 L${xDescente},44" ${ROUTE_SUIVIE}/>` +
      `<polygon points="${xDescente},58 ${xDescente - 8},44 ${xDescente + 8},44" fill="#ffffff"/>`
  );
}

function svgArrivee() {
  return svg(
    `<line x1="26" y1="64" x2="26" y2="12" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>` +
      `<path d="M26,12 H54 L47,22 L54,32 H26 Z" fill="#ffffff"/>`
  );
}
