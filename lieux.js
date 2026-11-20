// ---------------------------------------------------------------
// Lieux : commerces, restaurants, santé, services… (points d'intérêt)
// ---------------------------------------------------------------
// Chargé après main.js : réutilise sa carte (map) et son GPS (definirPoint, calculerTrajet, ouvrirGps…).
// - Affichage : la couche « poi » des tuiles OpenFreeMap (nom, catégorie, position), avec une pastille
//   colorée par catégorie. Les lieux importants passent en priorité quand ils se chevauchent.
// - Toucher un lieu : bulle avec ce que l'on sait tout de suite (nom, type, adresse approchée par la
//   Base Adresse Nationale), complétée par les données OpenStreetMap (adresse exacte, horaires,
//   téléphone, site web) via Nominatim, ou Overpass en secours. Boutons « Y aller » et « Ajouter au trajet ».
// - Bandeau du bas (GPS fermé) : recherche de lieux et d'adresses, et menu « ☰ » des types affichés.
(() => {
  const ZOOM_LIEUX = 15; // en dessous, les lieux ne s'affichent pas (trop nombreux)
  const ZOOM_NOMS = 16; // à partir de ce zoom, le nom s'affiche à côté de la pastille
  const DELAI_OVERPASS_MS = 30000; // au-delà, on abandonne (horaires et contact indisponibles)

  // Catégories affichées : couleur et symbole de la pastille
  const CATEGORIES = {
    alimentation: { libelle: "Alimentation", couleur: "#16a34a", symbole: "🛒" },
    restauration: { libelle: "Restauration", couleur: "#ea580c", symbole: "🍴" },
    commerces: { libelle: "Commerce", couleur: "#db2777", symbole: "🛍" },
    sante: { libelle: "Santé", couleur: "#dc2626", symbole: "✚" },
    services: { libelle: "Service", couleur: "#7c3aed", symbole: "ℹ" },
    hebergement: { libelle: "Hébergement", couleur: "#0891b2", symbole: "🛏" },
    parking: { libelle: "Parking", couleur: "#475569", symbole: "P" },
    // Résultats de recherche hors catégories (adresse, rue, ville…) : jamais affichés comme pastilles
    autre: { libelle: "Lieu", couleur: "#374151", symbole: "•", surLaCarte: false },
  };
  // Catégories que l'on peut afficher sur la carte (menu « ☰ » à droite du bandeau de recherche)
  const CATEGORIES_CARTE = Object.keys(CATEGORIES).filter((c) => CATEGORIES[c].surLaCarte !== false);

  // Sous-classe des tuiles (schéma OpenMapTiles) -> [catégorie, nom affiché]
  const SOUS_CLASSES = {
    supermarket: ["alimentation", "Supermarché"],
    convenience: ["alimentation", "Supérette"],
    bakery: ["alimentation", "Boulangerie"],
    butcher: ["alimentation", "Boucherie"],
    greengrocer: ["alimentation", "Primeur"],
    deli: ["alimentation", "Épicerie fine"],
    marketplace: ["alimentation", "Marché"],
    department_store: ["alimentation", "Grand magasin"],
    restaurant: ["restauration", "Restaurant"],
    fast_food: ["restauration", "Restauration rapide"],
    cafe: ["restauration", "Café"],
    bar: ["restauration", "Bar"],
    pub: ["restauration", "Pub"],
    ice_cream: ["restauration", "Glacier"],
    clothes: ["commerces", "Vêtements"],
    shoes: ["commerces", "Chaussures"],
    hairdresser: ["commerces", "Coiffeur"],
    beauty: ["commerces", "Institut de beauté"],
    cosmetics: ["commerces", "Parfumerie"],
    jewelry: ["commerces", "Bijouterie"],
    optician: ["commerces", "Opticien"],
    books: ["commerces", "Librairie"],
    florist: ["commerces", "Fleuriste"],
    furniture: ["commerces", "Meubles"],
    hardware: ["commerces", "Quincaillerie"],
    doityourself: ["commerces", "Bricolage"],
    electronics: ["commerces", "Électronique"],
    mobile_phone: ["commerces", "Téléphonie"],
    alcohol: ["commerces", "Caviste"],
    wine: ["commerces", "Caviste"],
    bicycle: ["commerces", "Vélos"],
    pharmacy: ["sante", "Pharmacie"],
    hospital: ["sante", "Hôpital"],
    clinic: ["sante", "Clinique"],
    doctors: ["sante", "Médecin"],
    dentist: ["sante", "Dentiste"],
    veterinary: ["sante", "Vétérinaire"],
    bank: ["services", "Banque"],
    atm: ["services", "Distributeur de billets"],
    post_office: ["services", "Bureau de poste"],
    police: ["services", "Police"],
    townhall: ["services", "Mairie"],
    toilets: ["services", "Toilettes"],
    laundry: ["services", "Laverie"],
    car_repair: ["services", "Garage"],
    charging_station: ["services", "Borne de recharge"],
    hotel: ["hebergement", "Hôtel"],
    guest_house: ["hebergement", "Chambre d'hôtes"],
    hostel: ["hebergement", "Auberge de jeunesse"],
    parking: ["parking", "Parking"],
  };
  // Autres magasins (classe « shop » sans sous-classe connue ci-dessus)
  const CLASSES_COMMERCES = ["shop", "clothing_store", "alcohol_shop"];

  // Expression MapLibre : catégorie d'un lieu des tuiles ("" = lieu non affiché)
  const categorieDe = [
    "match",
    ["get", "subclass"],
    ...Object.entries(SOUS_CLASSES).flatMap(([sousClasse, [categorie]]) => [sousClasse, categorie]),
    ["match", ["get", "class"], CLASSES_COMMERCES, "commerces", ""],
  ];
  const nomDe = ["coalesce", ["get", "name:fr"], ["get", "name"], ""];

  // Pastille d'une catégorie (dessinée en canvas, taille x2 pour les écrans haute densité)
  function pastille({ couleur, symbole }) {
    const t = 44;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = t;
    const g = canvas.getContext("2d");
    g.beginPath();
    g.arc(t / 2, t / 2, t / 2 - 3, 0, Math.PI * 2);
    g.fillStyle = couleur;
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "#ffffff";
    g.stroke();
    g.fillStyle = "#ffffff";
    g.font = "bold 22px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(symbole, t / 2, t / 2 + 1);
    return g.getImageData(0, 0, t, t);
  }

  function ajouterCouche() {
    for (const [nom, categorie] of Object.entries(CATEGORIES)) {
      if (!map.hasImage(`lieu-${nom}`)) map.addImage(`lieu-${nom}`, pastille(categorie), { pixelRatio: 2 });
    }
    map.addLayer(
      {
        id: "lieux",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "poi",
        minzoom: ZOOM_LIEUX,
        filter: filtreLieux(),
        layout: {
          "icon-image": ["concat", "lieu-", categorieDe],
          "text-field": ["step", ["zoom"], "", ZOOM_NOMS, nomDe],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-anchor": "left",
          "text-offset": [1.1, 0],
          "text-max-width": 8,
          "text-optional": true, // pas la place pour le nom : la pastille seule
          "symbol-sort-key": ["get", "rank"], // rang faible = lieu important, placé en premier
        },
        paint: {
          "text-color": "#374151",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      },
      map.getLayer("trajet-contour") ? "trajet-contour" : undefined // le trajet reste par-dessus
    );
  }
  // --- Types de lieux affichés (menu « ☰ » : une ligne par type avec un interrupteur) ---
  // Le choix est retenu sur l'appareil (localStorage), tous les types sont affichés par défaut.
  const CLE_TYPES = "p02-types-lieux";
  let typesAffiches = new Set(CATEGORIES_CARTE);
  try {
    const memorise = JSON.parse(localStorage.getItem(CLE_TYPES));
    if (Array.isArray(memorise)) typesAffiches = new Set(memorise.filter((c) => CATEGORIES_CARTE.includes(c)));
  } catch {
    // stockage indisponible (navigation privée…) : tous les types
  }

  function filtreLieux() {
    return ["in", categorieDe, ["literal", [...typesAffiches]]];
  }

  const elTypes = {
    bouton: document.getElementById("recherche-types"),
    panneau: document.getElementById("types-lieux"),
    liste: document.getElementById("types-lieux-liste"),
  };
  for (const nom of CATEGORIES_CARTE) {
    const { libelle, couleur, symbole } = CATEGORIES[nom];
    const ligne = document.createElement("label");
    ligne.className = "option";
    ligne.innerHTML =
      '<span class="type-lieu"><span class="pastille-lieu" aria-hidden="true"></span><span></span></span>' +
      '<input type="checkbox" role="switch" /><span class="switch" aria-hidden="true"></span>';
    const pastilleLieu = ligne.querySelector(".pastille-lieu");
    pastilleLieu.style.background = couleur;
    pastilleLieu.textContent = symbole;
    ligne.querySelector(".type-lieu span:last-child").textContent = libelle;
    const interrupteur = ligne.querySelector("input");
    interrupteur.checked = typesAffiches.has(nom);
    interrupteur.addEventListener("change", () => {
      if (interrupteur.checked) typesAffiches.add(nom);
      else typesAffiches.delete(nom);
      if (map.getLayer("lieux")) map.setFilter("lieux", filtreLieux());
      try {
        localStorage.setItem(CLE_TYPES, JSON.stringify([...typesAffiches]));
      } catch {
        // pas grave : le choix vaut pour cette visite
      }
    });
    elTypes.liste.append(ligne);
  }

  function afficherTypes(ouvrir) {
    elTypes.panneau.hidden = !ouvrir;
    elTypes.bouton.setAttribute("aria-expanded", String(ouvrir));
    if (ouvrir) afficherResultats(false);
  }
  elTypes.bouton.addEventListener("click", () => afficherTypes(elTypes.panneau.hidden));

  // La couche est ajoutée une fois les types connus (main.js ajoute d'abord le trajet, on passe dessous)
  if (map.getLayer("trajet-contour")) ajouterCouche();
  else map.once("load", ajouterCouche);

  // --- Bulle d'information ---
  const popup = new maplibregl.Popup({ anchor: "bottom", offset: [0, -12], maxWidth: "270px" });
  let lieuOuvert = null; // lieu affiché dans la bulle (pour ignorer les réponses arrivées trop tard)

  // Horaires OpenStreetMap (« Mo-Sa 08:30-20:00; Su off ») en français, une ligne par règle
  const JOURS = { Mo: "lun", Tu: "mar", We: "mer", Th: "jeu", Fr: "ven", Sa: "sam", Su: "dim", PH: "jours fériés" };
  function horairesEnFrancais(texte) {
    return texte
      .split(";")
      .map((regle) =>
        regle
          .trim()
          .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (j) => JOURS[j])
          .replace(/\boff\b/g, "fermé")
          .replace(/,(?! )/g, ", ") // « dim,jours fériés » -> « dim, jours fériés »
          .replace("24/7", "24 h/24, 7 j/7")
      )
      .filter(Boolean);
  }

  // Identifiant des tuiles -> objet OpenStreetMap : id = numéro OSM × 10 + (1 nœud, 2 chemin, 3 relation)
  function objetOsm(idTuile) {
    if (!Number.isFinite(idTuile)) return null;
    const type = { 1: "node", 2: "way", 3: "relation" }[idTuile % 10];
    return type ? `${type}(${Math.floor(idTuile / 10)})` : null;
  }

  // Étiquettes OpenStreetMap du lieu (adresse, horaires, téléphone, site…), mises en cache.
  // 1. Nominatim (recherche par identifiant OSM) : mêmes données, réponse en ~1 s ;
  // 2. sinon Overpass, souvent saturé (file d'attente jusqu'à ~25 s) : seul moyen pour un lieu sans identifiant.
  const cacheOsm = new Map();
  function etiquettesOsm(lieu) {
    const cle = lieu.osm ?? `${lieu.nom}@${lieu.lngLat}`;
    if (!cacheOsm.has(cle)) {
      const promesse = (async () => {
        try {
          const tags = lieu.osm && (await etiquettesNominatim(lieu.osm));
          if (tags) return tags;
        } catch {
          // Nominatim indisponible : Overpass prend le relais
        }
        return etiquettesOverpass(lieu);
      })();
      cacheOsm.set(cle, promesse);
      promesse.catch(() => cacheOsm.delete(cle)); // en cas d'échec, on réessaiera au prochain toucher
    }
    return cacheOsm.get(cle);
  }

  // Nominatim : « node(97075442) » -> lookup?osm_ids=N97075442. Les étiquettes utiles sont dans « extratags » ;
  // l'adresse n'est reprise que si elle a un numéro (sinon c'est juste la rue la plus proche)
  async function etiquettesNominatim(osm) {
    const [, type, id] = osm.match(/^(node|way|relation)\((\d+)\)$/) ?? [];
    if (!type) return null;
    const url = `https://nominatim.openstreetmap.org/lookup?format=jsonv2&extratags=1&addressdetails=1&osm_ids=${type[0].toUpperCase()}${id}`;
    const reponse = await fetch(url, { headers: { "Accept-Language": "fr" } });
    if (!reponse.ok) throw new Error("HTTP " + reponse.status);
    const [resultat] = await reponse.json();
    if (!resultat) return null; // objet inconnu de Nominatim : on essaie Overpass
    const a = resultat.address ?? {};
    const adresse = a.house_number
      ? {
          "addr:housenumber": a.house_number,
          "addr:street": a.road ?? a.pedestrian ?? a.square,
          "addr:postcode": a.postcode,
          "addr:city": a.city ?? a.town ?? a.village,
        }
      : {};
    return { ...(resultat.extratags ?? {}), ...adresse };
  }

  // Overpass : les 3 serveurs en même temps, la première réponse valable l'emporte et annule les autres
  function etiquettesOverpass(lieu) {
    const nomEchappe = lieu.nom.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const selection = lieu.osm
      ? `${lieu.osm};`
      : `nwr(around:30,${lieu.lngLat[1]},${lieu.lngLat[0]})["name"="${nomEchappe}"];`;
    const requete = `[out:json][timeout:10];${selection}out tags 1;`;
    const controle = new AbortController();
    const minuteur = setTimeout(() => controle.abort(), DELAI_OVERPASS_MS);
    return Promise.any(
      SERVEURS_OVERPASS.map(async (url) => {
        const reponse = await fetch(url, { method: "POST", body: new URLSearchParams({ data: requete }), signal: controle.signal });
        if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
        const { elements = [] } = await reponse.json();
        return elements[0]?.tags ?? {};
      })
    ).finally(() => {
      clearTimeout(minuteur);
      controle.abort(); // les serveurs encore en attente sont abandonnés
    });
  }

  // Adresse approchée (la plus proche du point), par la Base Adresse Nationale : rapide, mais pas forcément
  // l'adresse déclarée par le commerce
  async function adresseProche([lng, lat]) {
    const reponse = await fetch(`${URL_ADRESSE_INVERSE}?lon=${lng}&lat=${lat}&limit=1`);
    if (!reponse.ok) return null;
    const p = (await reponse.json()).features?.[0]?.properties;
    return p?.label && p.distance <= DISTANCE_ADRESSE_MAX_M ? p.label : null;
  }

  function adresseOsm(tags) {
    const rue = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    if (!rue) return null;
    return [rue, [tags["addr:postcode"], tags["addr:city"]].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }

  // Lien vers un site (http / https uniquement), ouvert dans un nouvel onglet
  function lien(url, texte) {
    const a = document.createElement("a");
    if (/^https?:\/\//i.test(url)) a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = texte;
    return a;
  }

  function contenuBulle(lieu) {
    const div = document.createElement("div");
    div.className = "popup-lieu";
    div.innerHTML =
      '<h3></h3><div class="type"></div><div class="adresse"></div>' +
      '<div class="horaires" hidden></div><div class="contact" hidden></div><div class="osm"></div>';
    div.querySelector("h3").textContent = lieu.nom || lieu.type;
    div.querySelector(".type").textContent = lieu.type;
    div.querySelector(".type").style.color = CATEGORIES[lieu.categorie].couleur;
    div.querySelector(".adresse").textContent = "📍 Recherche de l'adresse…";
    div.querySelector(".osm").textContent = "Recherche des horaires et du contact…";

    const aller = document.createElement("button");
    aller.type = "button";
    aller.className = "aller";
    aller.textContent = "🧭 Y aller";
    aller.addEventListener("click", () => allerVers(lieu));
    div.append(aller);
    // Un trajet est prêt (ou en cours) : on peut y ajouter le lieu comme étape
    if (nav || (points.depart && points.arrivee)) {
      const ajouter = document.createElement("button");
      ajouter.type = "button";
      ajouter.className = "ajouter";
      ajouter.textContent = "➕ Ajouter au trajet";
      ajouter.addEventListener("click", () => ajouterAuTrajet(lieu));
      div.append(ajouter);
    }
    return div;
  }

  // Remplit la bulle au fur et à mesure : adresse approchée d'abord, puis données OpenStreetMap
  function completerBulle(lieu, div) {
    const elAdresse = div.querySelector(".adresse");
    const elOsm = div.querySelector(".osm");
    // Lieu venu de la recherche : son adresse est déjà connue, pas besoin de l'approcher
    let adresseExacte = Boolean(lieu.adresse);
    if (adresseExacte) elAdresse.textContent = `📍 ${lieu.adresse}`;

    if (!adresseExacte) adresseProche(lieu.lngLat)
      .then((adresse) => {
        if (lieuOuvert !== lieu || adresseExacte) return;
        elAdresse.textContent = adresse ? `📍 ${adresse} (adresse la plus proche)` : "📍 Adresse inconnue";
        if (adresse) lieu.adresse = adresse;
      })
      .catch(() => {
        if (lieuOuvert === lieu && !adresseExacte) elAdresse.textContent = "📍 Adresse inconnue";
      });

    // Adresse, rue, ville… (résultat de recherche) : pas d'horaires ni de contact à chercher
    if (lieu.categorie === "autre") {
      elOsm.textContent = "";
      return;
    }
    etiquettesOsm(lieu)
      .then((tags) => {
        if (lieuOuvert !== lieu) return;
        elOsm.textContent = "";
        const adresse = adresseOsm(tags);
        if (adresse) {
          adresseExacte = true;
          lieu.adresse = adresse;
          elAdresse.textContent = `📍 ${adresse}`;
        }
        const horaires = tags.opening_hours && horairesEnFrancais(tags.opening_hours);
        if (horaires?.length) {
          const el = div.querySelector(".horaires");
          el.hidden = false;
          el.textContent = "🕒 " + horaires.join("\n");
        }
        const telephone = tags.phone ?? tags["contact:phone"];
        const site = tags.website ?? tags["contact:website"];
        if (telephone || site) {
          const el = div.querySelector(".contact");
          el.hidden = false;
          if (telephone) {
            const appel = document.createElement("a");
            appel.href = `tel:${telephone.replace(/[^\d+]/g, "")}`; // seulement chiffres et « + »
            appel.textContent = `📞 ${telephone}`;
            el.append(appel);
          }
          if (site) el.append(lien(site, `🌐 ${site.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")}`));
        }
        if (!horaires?.length && !telephone && !site) elOsm.textContent = "Pas d'horaires ni de contact renseignés.";
      })
      .catch(() => {
        if (lieuOuvert === lieu) elOsm.textContent = "Horaires et contact indisponibles (serveurs OpenStreetMap saturés).";
      });
  }

  function ouvrirBulle(lieu) {
    // Fermer d'abord l'éventuelle bulle ouverte : son événement « close » remet lieuOuvert à null,
    // il doit passer AVANT qu'on enregistre le nouveau lieu (sinon ses infos seraient ignorées)
    popup.remove();
    lieuOuvert = lieu;
    const div = contenuBulle(lieu);
    popup.setLngLat(lieu.lngLat).setDOMContent(div).addTo(map);
    completerBulle(lieu, div);
  }
  popup.on("close", () => (lieuOuvert = null));

  // Toucher un lieu (sauf pendant le choix d'un point sur la carte ou avec le menu détaillé ouvert :
  // le toucher place alors un point du trajet, voir main.js)
  map.on("click", "lieux", (e) => {
    if (selection?.pointage || menuOuvert()) return;
    const f = e.features?.[0];
    if (!f) return;
    const [categorie, type] = SOUS_CLASSES[f.properties.subclass] ?? ["commerces", "Commerce"];
    ouvrirBulle({
      nom: f.properties["name:fr"] ?? f.properties.name ?? "",
      type,
      categorie,
      lngLat: f.geometry.coordinates.slice(0, 2),
      osm: objetOsm(f.id),
      adresse: null,
    });
  });
  map.on("mouseenter", "lieux", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "lieux", () => (map.getCanvas().style.cursor = ""));

  // --- Recherche (bandeau du bas, GPS fermé) ---
  // 1. Lieux déjà chargés sur la carte dont le nom contient le texte (instantané, autour de la vue) ;
  // 2. Photon (recherche OpenStreetMap, komoot) : commerces, adresses, rues, villes, classés par
  //    proximité avec le centre de la carte. Un toucher sur un résultat centre la carte et ouvre sa bulle.
  const URL_PHOTON = "https://photon.komoot.io/api/";
  const NB_RESULTATS = 8;
  const elRecherche = {
    form: document.getElementById("recherche"),
    texte: document.getElementById("recherche-texte"),
    resultats: document.getElementById("recherche-resultats"),
    statut: document.getElementById("recherche-statut"),
    liste: document.getElementById("recherche-liste"),
  };
  let numeroRecherche = 0; // ignore les réponses d'une recherche dépassée

  function afficherResultats(ouvrir) {
    elRecherche.resultats.hidden = !ouvrir;
    if (ouvrir) afficherTypes(false);
  }

  // Comparaison sans accents ni majuscules (« creperie » trouve « Crêperie »)
  const simplifier = (texte) => texte.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // 1. Lieux des tuiles chargées, trouvés par leur nom (« Lidl ») ou leur type (« boulangerie »)
  function lieuxCharges(texte) {
    const cherche = simplifier(texte);
    const vus = new Set();
    const trouves = [];
    for (const f of map.querySourceFeatures("openmaptiles", { sourceLayer: "poi" })) {
      const nom = f.properties["name:fr"] ?? f.properties.name;
      const sousClasse = SOUS_CLASSES[f.properties.subclass];
      if (!sousClasse && !CLASSES_COMMERCES.includes(f.properties.class)) continue; // poubelle, banc…
      const [categorie, type] = sousClasse ?? ["commerces", "Commerce"];
      if (!simplifier(nom ?? "").includes(cherche) && !simplifier(type).includes(cherche)) continue;
      const cle = f.id ?? `${nom}@${f.geometry.coordinates}`;
      if (vus.has(cle)) continue; // un même lieu peut être dans plusieurs tuiles
      vus.add(cle);
      trouves.push({ nom: nom ?? "", type, categorie, lngLat: f.geometry.coordinates.slice(0, 2), osm: objetOsm(f.id), adresse: null });
    }
    return trouves;
  }

  // Type affiché pour un résultat Photon (clé / valeur OpenStreetMap, ex. shop / supermarket)
  function typePhoton({ osm_key: cle, osm_value: valeur, type }) {
    if (SOUS_CLASSES[valeur]) return SOUS_CLASSES[valeur];
    if (cle === "shop") return ["commerces", "Commerce"];
    if (cle === "place" && ["city", "town", "village", "hamlet"].includes(valeur)) return ["autre", "Ville"];
    if (cle === "highway" || type === "street") return ["autre", "Rue"];
    if (type === "house") return ["autre", "Adresse"];
    return ["autre", "Lieu"];
  }

  // 2. Photon
  async function lieuxPhoton(texte) {
    const c = map.getCenter();
    const url = `${URL_PHOTON}?q=${encodeURIComponent(texte)}&lat=${c.lat}&lon=${c.lng}&limit=${NB_RESULTATS}&lang=fr`;
    const reponse = await fetch(url);
    if (!reponse.ok) throw new Error("HTTP " + reponse.status);
    const { features = [] } = await reponse.json();
    return features.map((f) => {
      const p = f.properties;
      const [categorie, type] = typePhoton(p);
      const rue = [p.housenumber, p.street].filter(Boolean).join(" ");
      const ville = [p.postcode, p.city].filter(Boolean).join(" ");
      const typeOsm = { N: "node", W: "way", R: "relation" }[p.osm_type];
      return {
        nom: p.name || rue || type,
        type,
        categorie,
        lngLat: f.geometry.coordinates,
        osm: typeOsm && p.osm_id ? `${typeOsm}(${p.osm_id})` : null,
        adresse: [rue, ville].filter(Boolean).join(", ") || null,
      };
    });
  }

  function afficherListeResultats(lieux) {
    const centre = map.getCenter().toArray();
    elRecherche.liste.innerHTML = "";
    for (const lieu of lieux) {
      const ligne = document.createElement("li");
      ligne.innerHTML =
        '<span class="pastille-lieu" aria-hidden="true"></span>' +
        '<span class="infos"><strong></strong><span class="detail"></span></span><span class="distance"></span>';
      const { couleur, symbole } = CATEGORIES[lieu.categorie];
      ligne.querySelector(".pastille-lieu").style.background = couleur;
      ligne.querySelector(".pastille-lieu").textContent = symbole;
      ligne.querySelector("strong").textContent = lieu.nom || lieu.type;
      ligne.querySelector(".detail").textContent = [lieu.type, lieu.adresse].filter(Boolean).join(" · ");
      ligne.querySelector(".distance").textContent = formatDistance(distanceM(centre, lieu.lngLat));
      ligne.addEventListener("click", () => {
        afficherResultats(false);
        map.flyTo({ center: lieu.lngLat, zoom: Math.max(map.getZoom(), 17) });
        ouvrirBulle(lieu);
      });
      elRecherche.liste.append(ligne);
    }
  }

  elRecherche.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const texte = elRecherche.texte.value.trim();
    if (!texte) return afficherResultats(false);
    const numero = ++numeroRecherche;
    elRecherche.texte.blur(); // range le clavier du téléphone
    afficherResultats(true);

    // Résultats immédiats (lieux visibles, du plus proche au plus loin), puis complétés par Photon,
    // dans son ordre (pertinence + proximité : « Marseille » donne la ville avant le « Bar de Marseille »)
    const centre = map.getCenter().toArray();
    const locaux = lieuxCharges(texte).sort((a, b) => distanceM(centre, a.lngLat) - distanceM(centre, b.lngLat));
    afficherListeResultats(locaux.slice(0, NB_RESULTATS));
    elRecherche.statut.textContent = "Recherche…";
    try {
      const distants = await lieuxPhoton(texte);
      if (numero !== numeroRecherche) return;
      // Lieux visibles d'abord (tous si l'on cherche un type, « boulangerie » : on veut les plus proches ;
      // 4 au plus si l'on cherche un nom), puis Photon, sans doublons (même objet OpenStreetMap)
      const cherche = simplifier(texte);
      const chercheUnType = Object.values(SOUS_CLASSES).some(([, type]) => simplifier(type).includes(cherche));
      const premiers = locaux.slice(0, chercheUnType || !distants.length ? NB_RESULTATS : NB_RESULTATS / 2);
      const dejaVus = new Set(premiers.map((l) => l.osm).filter(Boolean));
      const tous = [...premiers, ...distants.filter((l) => !l.osm || !dejaVus.has(l.osm))].slice(0, NB_RESULTATS);
      afficherListeResultats(tous);
      elRecherche.statut.textContent = tous.length ? "" : `Aucun résultat pour « ${texte} ».`;
    } catch {
      if (numero !== numeroRecherche) return;
      elRecherche.statut.textContent = locaux.length
        ? "Recherche élargie indisponible : seuls les lieux visibles sont listés."
        : "Recherche indisponible, réessayez.";
    }
  });
  // Champ vidé (✕ du champ de recherche) : la liste disparaît
  elRecherche.texte.addEventListener("input", () => {
    if (!elRecherche.texte.value) afficherResultats(false);
  });
  // Toucher la carte range la liste et le menu des types
  map.on("click", () => {
    afficherResultats(false);
    afficherTypes(false);
  });

  // --- Y aller / Ajouter au trajet (même principe que pour les stations-service) ---
  const texteLieu = (lieu) => [lieu.nom || lieu.type, lieu.adresse && `(${lieu.adresse})`].filter(Boolean).join(" ");

  // Le menu carburant se range pour laisser la place au GPS
  function rangerCarburant() {
    if (!document.getElementById("panneau-carburant").hidden) document.getElementById("bouton-carburant").click();
  }

  function allerVers(lieu) {
    popup.remove();
    definirPoint("arrivee", lieu.lngLat, texteLieu(lieu));
    if (nav) {
      // Navigation en cours : nouvel itinéraire depuis la position actuelle
      const origine = nav.derniere ?? points.depart?.lngLat;
      calculerTrajet({ origine, ajuster: false }).then((ok) => {
        if (ok && nav && origine) {
          surPosition({ coords: { longitude: origine[0], latitude: origine[1], heading: null }, synthetique: true });
        }
      });
      return;
    }
    rangerCarburant();
    if (points.depart) {
      calculerTrajet();
      afficherApercu();
    } else {
      ouvrirGps(); // bandeau de choix du départ
      message(`Choisissez un départ pour aller à ${lieu.nom || lieu.type}`);
    }
  }

  async function ajouterAuTrajet(lieu) {
    popup.remove();
    const along = routeActive ? progression(lieu.lngLat, true).parcouru : Infinity;
    if (!nav) {
      rangerCarburant();
      ouvrirGps(); // aperçu du trajet, mis à jour une fois l'étape ajoutée
    }
    await ajouterEtapeAuTrajet(lieu.lngLat, texteLieu(lieu), along);
  }
})();
