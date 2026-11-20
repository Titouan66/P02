// ---------------------------------------------------------------
// Carburant : stations-service réelles (prix des carburants, data.economie.gouv.fr)
// ---------------------------------------------------------------
// Chargé après main.js : réutilise sa carte (map) et son menu GPS (definirPoint, calculerTrajet…).
// Le style de la carte n'est pas modifié : les stations sont des marqueurs HTML posés par-dessus.
//
// Principe : toutes les stations de France sont chargées d'un coup au démarrage (~10 000, ~1 Mo
// compressé), puis filtrées localement. À l'écran on n'affiche que les 50 stations les plus
// proches du centre de la carte, et rien du tout si la carte est trop dézoomée.
(() => {
  const URL_STATIONS =
    "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/" +
    "prix-des-carburants-en-france-flux-instantane-v2/exports/json?limit=-1&select=" +
    "id,geom,adresse,ville,cp,gazole_prix,sp95_prix,sp98_prix,e10_prix,e85_prix,gplc_prix," +
    "gazole_maj,sp95_maj,sp98_maj,e10_maj,e85_maj,gplc_maj";
  const URL_ADRESSE = "https://data.geopf.fr/geocodage/search/"; // Base Adresse Nationale

  const MAX_STATIONS = 50; // nombre maximum de stations affichées
  const ZOOM_MIN = 9; // en dessous, aucune station n'est affichée
  // Taille d'une bulle de prix à l'écran (px) : deux bulles qui se chevaucheraient ne sont pas affichées
  // ensemble (la plus proche du centre gagne), sinon la carte dézoomée devient illisible
  const BULLE_LARGEUR = 66;
  const BULLE_HAUTEUR = 30;
  const RECHARGER_TOUTES_LES_MS = 10 * 60 * 1000; // les prix sont mis à jour toutes les ~10 min

  const LIBELLES = { sp95: "SP95", sp98: "SP98", gazole: "Gazole", e10: "E10", e85: "E85", gpl: "GPL" };
  // clé interne -> préfixe des champs de l'API (gplc_prix, gplc_maj…)
  const CHAMPS_API = { sp95: "sp95", sp98: "sp98", gazole: "gazole", e10: "e10", e85: "e85", gpl: "gplc" };
  const ZOOM_STATION = 15;
  const ZOOM_VILLE = 13;

  let stations = [];
  const marqueurs = new Map(); // id de station -> maplibregl.Marker
  const affichees = new Set(); // ids actuellement sur la carte
  let carburant = "sp95";
  let prixMax = Infinity; // Infinity = curseur tout à droite (pas de filtre)
  let marqueurUtilisateur = null;
  let stationPopup = null;
  let borneCurseur = { min: 0, max: 0 };

  const ui = {
    bouton: document.getElementById("bouton-carburant"),
    panneau: document.getElementById("panneau-carburant"),
    lieu: document.getElementById("carbu-lieu"),
    type: document.getElementById("carbu-type"),
    prix: document.getElementById("carbu-prix-max"),
    prixLabel: document.getElementById("carbu-prix-label"),
    statut: document.getElementById("carbu-statut"),
    liste: document.getElementById("carbu-liste"),
    afficherListe: document.getElementById("carbu-afficher-liste"),
    localiser: document.getElementById("carbu-localiser"),
    chercher: document.getElementById("carbu-chercher"),
  };

  const popup = new maplibregl.Popup({ anchor: "bottom", offset: [0, -34], maxWidth: "260px" });
  popup.on("close", () => {
    stationPopup = null;
    popupDetour = null;
  });

  const prixDe = (station) => station.prices[carburant];
  const textePrix = (station) => `${LIBELLES[carburant]} : ${prixDe(station).toFixed(3)} € / L`;
  const texteBulle = (station) => `${prixDe(station).toFixed(3)} €`;

  // --- Ouverture / fermeture du menu (un seul menu ouvert à la fois) ---
  function panneauOuvert() {
    return !ui.panneau.hidden;
  }

  function afficherPanneau(ouvrir) {
    ui.panneau.hidden = !ouvrir;
    ui.bouton.setAttribute("aria-expanded", String(ouvrir));
    rafraichir(); // les bulles n'existent que menu ouvert : on les affiche ou on les retire
  }

  ui.bouton.addEventListener("click", () => {
    const ouvrir = !panneauOuvert();
    if (ouvrir && gpsOuvert()) fermerGps(); // range le GPS (le trajet reste sur la carte)
    afficherPanneau(ouvrir);
  });
  // Ouvrir le GPS range le menu carburant (cet écouteur passe après celui de main.js)
  boutonGps.addEventListener("click", () => {
    if (gpsOuvert()) afficherPanneau(false);
  });

  // Liste des stations repliée par défaut (la carte reste visible) : le bouton la déplie / replie.
  // Les bulles de prix restent sur la carte dans les deux cas.
  function afficherListeStations(ouvrir) {
    ui.liste.hidden = !ouvrir;
    ui.afficherListe.setAttribute("aria-expanded", String(ouvrir));
    ui.afficherListe.textContent = ouvrir ? "⌄ Masquer la liste" : "› Afficher la liste";
  }
  ui.afficherListe.addEventListener("click", () => afficherListeStations(ui.liste.hidden));

  // Décalage horizontal pour que le point visé ne soit pas caché sous le menu
  const decalage = () => [panneauOuvert() || menuOuvert() ? 160 : 0, 0];

  // --- Chargement et normalisation des stations ---
  function harmoniser(brut) {
    if (!brut.geom || !Number.isFinite(brut.geom.lat) || !Number.isFinite(brut.geom.lon)) return null;
    const prices = {};
    const maj = {};
    for (const [cle, champ] of Object.entries(CHAMPS_API)) {
      const p = brut[`${champ}_prix`];
      if (typeof p === "number" && p > 0) {
        prices[cle] = p;
        maj[cle] = brut[`${champ}_maj`];
      }
    }
    if (!Object.keys(prices).length) return null; // station sans aucun prix
    const ville = brut.ville ?? "";
    return {
      id: brut.id,
      name: ville || "Station-service",
      address: [brut.adresse, [brut.cp, ville].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      lat: brut.geom.lat,
      lng: brut.geom.lon,
      prices,
      maj,
    };
  }

  async function chargerStations() {
    const reponse = await fetch(URL_STATIONS);
    if (!reponse.ok) throw new Error("HTTP " + reponse.status);
    const brutes = await reponse.json();
    return brutes.map(harmoniser).filter(Boolean);
  }

  // --- Marqueurs de prix sur la carte ---
  function marqueurDe(station) {
    let marqueur = marqueurs.get(station.id);
    if (marqueur) return marqueur;
    const elt = document.createElement("div");
    elt.className = "marqueur-station";
    elt.innerHTML = '<div class="bulle"></div>';
    elt.title = station.name;
    // stopPropagation : un clic sur une station ne place pas de point d'itinéraire
    elt.addEventListener("click", (e) => {
      e.stopPropagation();
      ouvrirPopup(station);
    });
    marqueur = new maplibregl.Marker({ element: elt, anchor: "bottom", offset: [0, -7] }).setLngLat([
      station.lng,
      station.lat,
    ]);
    marqueurs.set(station.id, marqueur);
    return marqueur;
  }

  function afficherMarqueurs(visibles) {
    const ids = new Set(visibles.map((s) => s.id));
    for (const id of affichees) {
      if (!ids.has(id)) marqueurs.get(id).remove();
    }
    affichees.clear();
    for (const station of visibles) {
      const marqueur = marqueurDe(station);
      marqueur.getElement().firstChild.textContent = texteBulle(station);
      marqueur.addTo(map);
      affichees.add(station.id);
    }
    if (stationPopup && !popupDetour && !ids.has(stationPopup.id)) popup.remove();
  }

  // --- Bulle d'information d'une station ---
  // detour : { extraS, extraKm } quand la station vient de la liste « sur le trajet »
  // (pas de bouton « Y aller » : il changerait la destination en pleine navigation).
  function contenuPopup(station, detour = null) {
    const div = document.createElement("div");
    div.className = "popup-station";
    div.innerHTML =
      '<h3></h3><div class="adresse"></div><div class="prix"></div><div class="detour"></div><div class="maj"></div>' +
      '<button type="button" class="aller">🧭 Y aller</button>';
    div.querySelector("h3").textContent = station.name;
    div.querySelector(".adresse").textContent = `📍 ${station.address}`;
    div.querySelector(".prix").textContent = textePrix(station);
    const maj = station.maj[carburant];
    if (maj) {
      div.querySelector(".maj").textContent =
        "Prix relevé le " + new Date(maj).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
    }
    const ajouter = document.createElement("button");
    ajouter.type = "button";
    ajouter.className = "ajouter";
    ajouter.textContent = "➕ Ajouter au trajet";
    ajouter.addEventListener("click", () => ajouterAuTrajet(station, detour?.along));

    if (detour) {
      div.querySelector(".detour").textContent = `Détour : ${texteDetour(detour)}`;
      div.querySelector(".aller").remove();
      div.append(ajouter);
    } else {
      div.querySelector(".detour").remove();
      div.querySelector(".aller").addEventListener("click", () => allerA(station));
      // Un trajet est en cours de préparation : on peut y ajouter la station comme étape
      if (points.arrivee) div.append(ajouter);
    }
    return div;
  }

  // Ajoute la station comme étape du trajet (à la bonne place), puis recalcule le trajet
  let ajoutEnCours = false;
  async function ajouterAuTrajet(station, along) {
    if (ajoutEnCours) return;
    ajoutEnCours = true;
    try {
      const lngLat = [station.lng, station.lat];
      const texte = `${station.name} (${station.address})`;
      if (along == null) along = routeActive ? progression(lngLat, true).parcouru : Infinity;

      if (nav) {
        route.statut.textContent = "Ajout de l'étape…";
        popup.remove();
        if (await ajouterEtapeAuTrajet(lngLat, texte, along)) fermerRoute();
        else route.statut.textContent = "Impossible d'ajouter cette étape (itinéraire indisponible).";
        return;
      }
      popup.remove();
      afficherPanneau(false);
      ouvrirGps(); // aperçu du trajet (les chiffres se mettent à jour une fois l'étape ajoutée)
      await ajouterEtapeAuTrajet(lngLat, texte, along);
    } finally {
      ajoutEnCours = false;
    }
  }

  let popupDetour = null;

  function ouvrirPopup(station, detour = null) {
    stationPopup = station;
    popupDetour = detour;
    popup.setLngLat([station.lng, station.lat]).setDOMContent(contenuPopup(station, detour)).addTo(map);
  }

  function centrerSur(station) {
    map.flyTo({ center: [station.lng, station.lat], zoom: ZOOM_STATION, offset: decalage() });
    ouvrirPopup(station);
  }

  // « Y aller » : la station devient l'arrivée du menu GPS
  function allerA(station) {
    const lngLat = [station.lng, station.lat];
    popup.remove();
    definirPoint("arrivee", lngLat, `${station.name} (${station.address})`);

    if (nav) {
      // Navigation en cours : nouvel itinéraire depuis la position actuelle
      const origine = nav.derniere ?? points.depart?.lngLat;
      calculerTrajet({ origine, ajuster: false }).then(() => {
        if (nav && origine) surPosition({ coords: { longitude: origine[0], latitude: origine[1], heading: null } });
      });
      return;
    }

    afficherPanneau(false);
    if (points.depart) {
      calculerTrajet(); // nouvelle arrivée : trajet recalculé et montré en entier
      afficherApercu();
    } else {
      ouvrirGps(); // bandeau de choix du départ
      message(`Choisissez un départ pour aller à ${station.name}`);
    }
  }

  // --- Liste des stations dans le menu ---
  function afficherListe(liste, centre) {
    ui.liste.innerHTML = "";
    if (liste.length === 0) {
      ui.liste.innerHTML = '<div class="aucune">Aucune station trouvée ici.</div>';
      return;
    }
    for (const station of liste) {
      const carte = document.createElement("div");
      carte.className = "carte-station";
      carte.innerHTML =
        '<h3></h3><div class="adresse"></div>' +
        '<div class="pied"><span class="prix"></span><span class="distance"></span>' +
        '<button type="button" class="aller" title="Itinéraire vers cette station">🧭</button></div>';
      carte.querySelector("h3").textContent = station.name;
      carte.querySelector(".adresse").textContent = `📍 ${station.address}`;
      carte.querySelector(".prix").textContent = textePrix(station);
      const km = distanceM(centre, [station.lng, station.lat]) / 1000;
      carte.querySelector(".distance").textContent = `${km.toFixed(1)} km`;
      carte.querySelector(".aller").addEventListener("click", (e) => {
        e.stopPropagation();
        allerA(station);
      });
      carte.addEventListener("click", () => centrerSur(station));
      ui.liste.append(carte);
    }
  }

  // --- Sélection des stations à afficher ---
  // Les 50 plus proches du centre de la carte, parmi celles visibles à l'écran,
  // qui proposent le carburant choisi à un prix <= prix max.
  function rafraichir() {
    if (!stations.length) return;

    // Menu carburant fermé (ou navigation en cours) : aucune bulle sur la carte
    if (!panneauOuvert()) {
      afficherMarqueurs([]);
      return;
    }

    if (map.getZoom() < ZOOM_MIN) {
      afficherMarqueurs([]);
      ui.liste.innerHTML = "";
      ui.statut.textContent = "Zoome sur la carte pour afficher les stations.";
      return;
    }

    const c = map.getCenter();
    const centre = [c.lng, c.lat];
    const cosLat = Math.cos((c.lat * Math.PI) / 180);
    const b = map.getBounds();
    const [ouest, sud, est, nord] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

    const candidats = [];
    for (const s of stations) {
      const p = s.prices[carburant];
      if (p === undefined || p > prixMax) continue;
      if (s.lat < sud || s.lat > nord || s.lng < ouest || s.lng > est) continue;
      const dx = (s.lng - c.lng) * cosLat;
      const dy = s.lat - c.lat;
      candidats.push({ s, d2: dx * dx + dy * dy });
    }
    candidats.sort((x, y) => x.d2 - y.d2);
    const visibles = candidats.slice(0, MAX_STATIONS).map((x) => x.s);

    afficherMarqueurs(sansChevauchement(candidats.map((x) => x.s)));
    afficherListe(visibles, centre);
    ui.statut.textContent =
      candidats.length > MAX_STATIONS
        ? `${LIBELLES[carburant]} : les ${MAX_STATIONS} stations les plus proches du centre (${candidats.length} dans la zone).`
        : `${LIBELLES[carburant]} : ${visibles.length} station(s) dans la zone.`;
  }

  // Bulles à poser sur la carte : on parcourt les stations de la plus proche du centre à la plus lointaine
  // et on garde celles qui ne chevauchent aucune bulle déjà gardée (au plus MAX_STATIONS)
  function sansChevauchement(triees) {
    const gardees = [];
    const places = []; // positions à l'écran des bulles gardées
    for (const s of triees) {
      if (gardees.length >= MAX_STATIONS) break;
      const { x, y } = map.project([s.lng, s.lat]);
      if (places.some((p) => Math.abs(p.x - x) < BULLE_LARGEUR && Math.abs(p.y - y) < BULLE_HAUTEUR)) continue;
      gardees.push(s);
      places.push({ x, y });
    }
    return gardees;
  }

  map.on("moveend", rafraichir);

  // --- Filtre de prix ---
  // Bornes du curseur : percentiles 1 % - 99 % sur toute la France (évite les prix aberrants).
  function reglerCurseurPrix() {
    const tous = stations.map(prixDe).filter((p) => p !== undefined).sort((a, b) => a - b);
    if (!tous.length) return;
    const min = Math.floor(tous[Math.floor(tous.length * 0.01)] * 100) / 100;
    const max = Math.ceil(tous[Math.floor(tous.length * 0.99)] * 100) / 100;
    borneCurseur = { min, max };
    ui.prix.min = min;
    ui.prix.max = max;
    ui.prix.value = max;
    prixMax = Infinity;
    majLabelPrix();
  }

  function majLabelPrix() {
    ui.prixLabel.textContent = prixMax === Infinity ? "tous" : `${prixMax.toFixed(2)} €`;
  }

  ui.prix.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    prixMax = v >= borneCurseur.max ? Infinity : v; // curseur au maximum = pas de filtre
    majLabelPrix();
    rafraichir();
  });

  ui.type.addEventListener("change", () => {
    carburant = ui.type.value;
    reglerCurseurPrix();
    if (stationPopup) {
      if (stationPopup.prices[carburant] === undefined) popup.remove();
      else popup.setDOMContent(contenuPopup(stationPopup, popupDetour));
    }
    rafraichir();
  });

  // --- Localisation ---
  function placerUtilisateur(lngLat) {
    if (!marqueurUtilisateur) {
      const elt = document.createElement("div");
      elt.className = "marqueur-utilisateur";
      marqueurUtilisateur = new maplibregl.Marker({ element: elt });
    }
    marqueurUtilisateur.setLngLat(lngLat).addTo(map);
    map.flyTo({ center: lngLat, zoom: ZOOM_VILLE + 1, offset: decalage() });
  }

  ui.localiser.addEventListener("click", () => {
    // Mode test de main.js (GPS_REEL = false) : la position est le point de départ du GPS
    if (!GPS_REEL && points.depart) {
      placerUtilisateur(points.depart.lngLat);
      return;
    }
    if (!navigator.geolocation) {
      ui.statut.textContent = "La géolocalisation n'est pas supportée par ce navigateur.";
      return;
    }
    ui.localiser.disabled = true;
    ui.statut.textContent = "Localisation en cours…";
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        placerUtilisateur([coords.longitude, coords.latitude]);
        ui.localiser.disabled = false;
      },
      (erreur) => {
        ui.statut.textContent = `Impossible de récupérer votre position (${erreur.message}).`;
        ui.localiser.disabled = false;
      },
      { timeout: 10000 }
    );
  });

  // --- Recherche d'une ville, d'un code postal ou d'une adresse (Base Adresse Nationale) ---
  async function rechercher() {
    const brut = ui.lieu.value.trim();
    if (!brut) return;
    ui.chercher.disabled = true;
    ui.statut.textContent = `Recherche de « ${brut} »…`;
    try {
      const reponse = await fetch(`${URL_ADRESSE}?limit=1&q=${encodeURIComponent(brut)}`);
      if (!reponse.ok) throw new Error("HTTP " + reponse.status);
      const { features } = await reponse.json();
      if (!features.length) {
        ui.statut.textContent = `Lieu introuvable pour « ${brut} ».`;
        return;
      }
      const [lng, lat] = features[0].geometry.coordinates;
      // Les stations s'affichent d'elles-mêmes à la fin du déplacement (événement moveend)
      map.flyTo({ center: [lng, lat], zoom: ZOOM_VILLE, offset: decalage() });
    } catch (err) {
      console.warn("Recherche d'adresse indisponible", err);
      ui.statut.textContent = "Recherche d'adresse indisponible.";
    } finally {
      ui.chercher.disabled = false;
    }
  }

  ui.chercher.addEventListener("click", rechercher);
  ui.lieu.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      rechercher();
    }
  });

  // ---------------------------------------------------------------
  // Pendant la navigation : les 5 stations qui font perdre le moins de temps
  // ---------------------------------------------------------------
  // 1. Présélection locale : stations devant nous, à moins de LATERAL_MAX_M du trajet restant,
  //    dans les HORIZON_M prochains mètres ; on garde les NB_CANDIDATS les plus proches de la route.
  // 2. Mesure réelle avec Valhalla (matrice de temps/distances) : pour chaque candidate,
  //    détour = (point d'avant -> station) + (station -> point d'après) - (point d'avant -> point d'après).
  // 3. Classement par temps perdu, on garde NB_RESULTATS.
  const NB_RESULTATS = 5;
  const NB_CANDIDATS = 20;
  const LATERAL_MAX_M = 5000;
  const HORIZON_M = 100000;
  const MARGE_AVANT_M = 1500; // on quitte la route un peu avant la station…
  const MARGE_APRES_M = 1500; // …et on la rejoint un peu après
  const TAILLE_LOT = 5; // Valhalla limite sources x cibles à 100 : 2 x 5 sources/cibles = 10 x 10
  const URL_MATRICE = "https://valhalla1.openstreetmap.de/sources_to_targets";

  const route = {
    bouton: document.getElementById("stations-route"),
    panneau: document.getElementById("panneau-route"),
    type: document.getElementById("route-type"),
    statut: document.getElementById("route-statut"),
    liste: document.getElementById("route-liste"),
    actualiser: document.getElementById("route-actualiser"),
    fermer: document.getElementById("route-fermer"),
  };
  let marqueursRoute = [];
  let sequenceRoute = 0;

  function texteDetour({ extraS, extraKm }) {
    const min = Math.round(extraS / 60);
    return `${min < 1 ? "< 1 min" : `+${min} min`} · +${extraKm.toFixed(1)} km`;
  }

  // Position [lng, lat] à la distance d (m) le long du trajet
  function pointA(r, d) {
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

  // Étape 1 : stations proches du trajet restant (calcul local, rapide)
  function preselectionner(r, segment, parcouru) {
    const fin = Math.min(r.total, parcouru + HORIZON_M);
    const k = Math.cos((r.coords[Math.min(segment, r.coords.length - 1)][1] * Math.PI) / 180);
    const versX = (lng) => lng * 111320 * k;
    const versY = (lat) => lat * 110540;

    // Trajet restant rééchantillonné tous les ~100 m, en mètres
    const px = [];
    const py = [];
    const pd = [];
    let dernier = -Infinity;
    for (let i = Math.max(0, segment); i < r.coords.length; i++) {
      const dernierPoint = i === r.coords.length - 1 || r.cumul[i] > fin;
      if (r.cumul[i] - dernier >= 100 || dernierPoint) {
        px.push(versX(r.coords[i][0]));
        py.push(versY(r.coords[i][1]));
        pd.push(r.cumul[i]);
        dernier = r.cumul[i];
      }
      if (r.cumul[i] > fin) break;
    }
    if (px.length < 2) return [];

    const minX = Math.min(...px) - LATERAL_MAX_M;
    const maxX = Math.max(...px) + LATERAL_MAX_M;
    const minY = Math.min(...py) - LATERAL_MAX_M;
    const maxY = Math.max(...py) + LATERAL_MAX_M;

    const candidates = [];
    for (const s of stations) {
      if (s.prices[carburant] === undefined) continue;
      const x = versX(s.lng);
      const y = versY(s.lat);
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      let meilleur2 = Infinity;
      let along = 0;
      for (let i = 0; i < px.length - 1; i++) {
        const dx = px[i + 1] - px[i];
        const dy = py[i + 1] - py[i];
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((x - px[i]) * dx + (y - py[i]) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px[i] + t * dx - x;
        const ey = py[i] + t * dy - y;
        const d2 = ex * ex + ey * ey;
        if (d2 < meilleur2) {
          meilleur2 = d2;
          along = pd[i] + t * (pd[i + 1] - pd[i]);
        }
      }
      if (meilleur2 <= LATERAL_MAX_M ** 2 && along >= parcouru && along <= fin) {
        candidates.push({ s, along, lateral: Math.sqrt(meilleur2) });
      }
    }
    candidates.sort((a, b) => a.lateral - b.lateral);
    return candidates.slice(0, NB_CANDIDATS);
  }

  // Étape 2 : détour réel (temps en s, distance en km) d'un lot de stations
  async function mesurerLot(r, lot, parcouru) {
    const avant = lot.map((c) => pointA(r, Math.max(parcouru, c.along - MARGE_AVANT_M)));
    const apres = lot.map((c) => pointA(r, c.along + MARGE_APRES_M));
    const stationsPts = lot.map((c) => [c.s.lng, c.s.lat]);
    const loc = ([lon, lat]) => ({ lon, lat });

    const optionsAuto = {};
    if (eviter.peages) optionsAuto.exclude_tolls = true;
    if (eviter.autoroutes) optionsAuto.use_highways = 0;

    const reponse = await fetch(URL_MATRICE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [...avant, ...stationsPts].map(loc),
        targets: [...stationsPts, ...apres].map(loc),
        costing: "auto",
        costing_options: { auto: optionsAuto },
      }),
    });
    if (!reponse.ok) throw new Error("HTTP " + reponse.status);
    const m = (await reponse.json()).sources_to_targets;
    const n = lot.length;

    const resultats = [];
    lot.forEach((c, i) => {
      const allee = m[i][i]; // avant -> station
      const retour = m[n + i][n + i]; // station -> après
      const direct = m[i][n + i]; // avant -> après (sans détour)
      if ([allee, retour, direct].some((x) => !x || x.time == null || x.distance == null)) return;
      resultats.push({
        ...c,
        extraS: Math.max(0, allee.time + retour.time - direct.time),
        extraKm: Math.max(0, allee.distance + retour.distance - direct.distance),
      });
    });
    return resultats;
  }

  // --- Affichage ---
  function effacerMarqueursRoute() {
    for (const m of marqueursRoute) m.remove();
    marqueursRoute = [];
  }

  function afficherResultatsRoute(resultats, position) {
    route.liste.innerHTML = "";
    effacerMarqueursRoute();

    resultats.forEach((res, i) => {
      const { s } = res;
      const detour = { extraS: res.extraS, extraKm: res.extraKm, along: res.along };

      const ligne = document.createElement("li");
      ligne.className = "resultat-route";
      ligne.innerHTML =
        `<span class="rang">${i + 1}</span>` +
        '<div class="infos"><strong></strong></div>' +
        '<div class="chiffres"><span class="prix"></span><span class="detour"></span></div>' +
        '<button type="button" class="ajouter" title="Ajouter cette station au trajet">➕ Ajouter</button>';
      ligne.querySelector(".ajouter").addEventListener("click", (e) => {
        e.stopPropagation();
        ajouterAuTrajet(s, res.along);
      });
      ligne.querySelector("strong").textContent = s.name;
      ligne.querySelector(".prix").textContent = `${prixDe(s).toFixed(3)} €`;
      ligne.querySelector(".detour").textContent = texteDetour(detour);

      const montrer = () => {
        const bornes = new maplibregl.LngLatBounds(position, position).extend([s.lng, s.lat]);
        pauseCamera(8000); // le suivi laisse la carte tranquille le temps de regarder la station
        map.fitBounds(bornes, {
          padding: { top: 140, bottom: 300, left: 60, right: 60 },
          maxZoom: 16,
          duration: 800,
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        });
        ouvrirPopup(s, detour);
      };
      ligne.addEventListener("click", montrer);
      route.liste.append(ligne);

      const elt = document.createElement("div");
      elt.className = "marqueur-station route";
      elt.innerHTML = '<div class="bulle"></div>';
      elt.firstChild.textContent = `${i + 1} · ${texteBulle(s)}`;
      elt.addEventListener("click", (e) => {
        e.stopPropagation();
        ouvrirPopup(s, detour);
      });
      marqueursRoute.push(
        new maplibregl.Marker({ element: elt, anchor: "bottom", offset: [0, -7] })
          .setLngLat([s.lng, s.lat])
          .addTo(map)
      );
    });
  }

  async function chercherSurTrajet() {
    const sequence = ++sequenceRoute;
    route.liste.innerHTML = "";
    effacerMarqueursRoute();

    const r = routeActive;
    if (!nav || !r) {
      route.statut.textContent = "Aucun trajet en cours.";
      return;
    }
    route.actualiser.disabled = true;
    route.statut.textContent = "Recherche des stations sur votre trajet…";
    await new Promise((ok) => setTimeout(ok, 30)); // laisse le message s'afficher

    try {
      const parcouru = nav.parcouru ?? 0;
      const position = nav.derniere ?? points.depart?.lngLat ?? r.coords[0];
      const candidates = preselectionner(r, nav.segment ?? 0, parcouru);
      if (!candidates.length) {
        route.statut.textContent = `Aucune station ${LIBELLES[carburant]} près du trajet (${HORIZON_M / 1000} prochains km).`;
        return;
      }

      const lots = [];
      for (let i = 0; i < candidates.length; i += TAILLE_LOT) lots.push(candidates.slice(i, i + TAILLE_LOT));
      const reponses = await Promise.allSettled(lots.map((lot) => mesurerLot(r, lot, parcouru)));
      if (sequence !== sequenceRoute) return; // une recherche plus récente a pris le relais
      if (r !== routeActive) return chercherSurTrajet(); // trajet recalculé entre-temps

      const mesures = reponses.filter((x) => x.status === "fulfilled").flatMap((x) => x.value);
      if (!mesures.length) {
        const echec = reponses.find((x) => x.status === "rejected");
        if (echec) console.warn("Calcul des détours impossible", echec.reason);
        route.statut.textContent = echec
          ? "Service d'itinéraire indisponible, réessayez."
          : "Aucune station accessible sans trop de détour.";
        return;
      }

      mesures.sort((a, b) => a.extraS - b.extraS || prixDe(a.s) - prixDe(b.s));
      afficherResultatsRoute(mesures.slice(0, NB_RESULTATS), position);
      route.statut.textContent =
        `${LIBELLES[carburant]} · les ${Math.min(NB_RESULTATS, mesures.length)} stations qui font perdre le moins ` +
        `de temps (${HORIZON_M / 1000} prochains km).`;
    } catch (err) {
      console.warn("Recherche de stations sur le trajet impossible", err);
      route.statut.textContent = "Recherche impossible, réessayez.";
    } finally {
      if (sequence === sequenceRoute) route.actualiser.disabled = false;
    }
  }

  function routeOuvert() {
    return !route.panneau.hidden;
  }

  function fermerRoute() {
    sequenceRoute++; // annule une recherche en cours
    route.panneau.hidden = true;
    route.bouton.setAttribute("aria-expanded", "false");
    effacerMarqueursRoute();
    if (popupDetour) popup.remove();
  }

  route.bouton.addEventListener("click", () => {
    if (routeOuvert()) return fermerRoute();
    route.panneau.hidden = false;
    route.bouton.setAttribute("aria-expanded", "true");
    route.type.value = carburant;
    chercherSurTrajet();
  });
  route.fermer.addEventListener("click", fermerRoute);
  route.actualiser.addEventListener("click", chercherSurTrajet);
  route.type.addEventListener("change", () => {
    // Même choix de carburant que dans le menu Carburant
    ui.type.value = route.type.value;
    ui.type.dispatchEvent(new Event("change"));
    chercherSurTrajet();
  });

  // Fin de la navigation (bouton « Arrêter » ou arrivée) : on range le panneau
  new MutationObserver(() => {
    const navigation = document.body.classList.contains("navigation");
    if (!navigation && routeOuvert()) fermerRoute();
    // Le menu carburant est masqué pendant la navigation : on le ferme aussi (et ses bulles)
    if (navigation && panneauOuvert()) afficherPanneau(false);
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // --- Démarrage et rafraîchissement périodique ---
  function remplacerStations(nouvelles) {
    for (const marqueur of marqueurs.values()) marqueur.remove();
    marqueurs.clear();
    affichees.clear();
    stations = nouvelles;
    // La station ouverte dans la bulle est remplacée par sa version à jour
    if (stationPopup) {
      const maj = stations.find((s) => s.id === stationPopup.id);
      if (maj) stationPopup = maj;
      else popup.remove();
    }
  }

  async function init() {
    ui.statut.textContent = "Chargement des stations…";
    try {
      remplacerStations(await chargerStations());
    } catch (err) {
      console.warn("Impossible de charger les stations", err);
      ui.statut.textContent = "Impossible de charger les prix des carburants.";
      return;
    }
    carburant = ui.type.value;
    reglerCurseurPrix();
    rafraichir();

    setInterval(async () => {
      try {
        remplacerStations(await chargerStations());
        rafraichir();
      } catch (err) {
        console.warn("Mise à jour des prix impossible", err);
      }
    }, RECHARGER_TOUTES_LES_MS);
  }

  init();
})();
