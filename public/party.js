/* venuehunt: find party venues near an address, then request availability + a quote. */
(function () {
  "use strict";

  // Settings live in config.js (Google Maps key for address suggestions, optional request endpoint).
  var CONFIG = window.VENUE_HUNT_CONFIG || {};

  var MIN_DAYS_NOTICE = 5;
  var MILE_M = 1609.344;
  var PAGE_SIZE = 5;
  var STORE_KEY = "venuehunt.requests.v1";
  var OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ];

  // Venue categories: label, emoji, capacity range used when OSM has no capacity tag,
  // per-guest prices for [drinks, buffet, seated], and a flat room/rental fee.
  var TYPES = {
    restaurant:        { group: "restaurant", label: "Restaurant",        emoji: "🍝", cap: [30, 140],  pp: [35, 55, 75],  room: 0 },
    bar:               { group: "bar",        label: "Bar",               emoji: "🍸", cap: [40, 150],  pp: [30, 45, 60],  room: 0 },
    pub:               { group: "bar",        label: "Pub",               emoji: "🍺", cap: [50, 160],  pp: [28, 42, 58],  room: 0 },
    biergarten:        { group: "bar",        label: "Beer garden",       emoji: "🌳", cap: [80, 260],  pp: [28, 42, 55],  room: 0 },
    nightclub:         { group: "bar",        label: "Club",              emoji: "🪩", cap: [150, 450], pp: [40, 55, 70],  room: 500 },
    events_venue:      { group: "venue",      label: "Event space",       emoji: "🎪", cap: [80, 400],  pp: [30, 60, 85],  room: 750 },
    community_centre:  { group: "venue",      label: "Community hall",    emoji: "🏛️", cap: [60, 250],  pp: [15, 35, 50],  room: 300 },
    conference_centre: { group: "venue",      label: "Conference center", emoji: "🎤", cap: [150, 800], pp: [35, 65, 90],  room: 1200 },
    hotel:             { group: "venue",      label: "Hotel ballroom",    emoji: "🏨", cap: [50, 300],  pp: [40, 75, 105], room: 900 }
  };
  var STYLE_INDEX = { drinks: 0, buffet: 1, seated: 2 };
  var STYLE_LABEL = { drinks: "Drinks + light bites", buffet: "Buffet / family style", seated: "Seated dinner" };
  var CUISINE_MULT = {
    steak_house: 1.4, sushi: 1.3, japanese: 1.25, french: 1.2, seafood: 1.2, italian: 1.1,
    pizza: 0.8, mexican: 0.85, burger: 0.8, chinese: 0.9, thai: 0.9, indian: 0.9, american: 0.95
  };

  var $ = function (id) { return document.getElementById(id); };
  var state = { origin: null, venues: [], byId: {}, steps: [], stepIndex: 0, covered: 0, shownCount: 5, search: null, active: null, map: null, layer: null, markers: {} };

  /* ---------- dates ---------- */

  function todayLocal() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function parseDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
    var p = s.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return isNaN(d) ? null : d;
  }
  function toISO(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function daysOut(s) {
    var d = parseDate(s);
    return d ? Math.round((d - todayLocal()) / 86400000) : null;
  }
  function canRequest(s) { var n = daysOut(s); return n !== null && n >= MIN_DAYS_NOTICE; }
  function earliestRequestDate() { var d = todayLocal(); d.setDate(d.getDate() + MIN_DAYS_NOTICE); return toISO(d); }
  function prettyDate(s) {
    var d = parseDate(s);
    return d ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : s;
  }

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) { return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }); }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }
  function haversineMiles(a, b) {
    var R = 3958.8, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function fetchJSON(url, opts, ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms || 30000);
    return fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .finally(function () { clearTimeout(t); });
  }
  function setLoading(on, text) {
    $("loading").hidden = !on;
    if (text) $("loading-text").textContent = text;
    $("search-btn").disabled = on;
  }

  /* ---------- data ---------- */

  function overpassQuery(o, miles) {
    var r = Math.round(miles * MILE_M);
    var around = "(around:" + r + "," + o.lat + "," + o.lon + ")";
    return "[out:json][timeout:25];(" +
      'nwr["amenity"~"^(restaurant|bar|pub|biergarten|nightclub|events_venue|community_centre|conference_centre)$"]["name"]' + around + ";" +
      'nwr["tourism"="hotel"]["name"]' + around + ";" +
      ");out center tags 1500;";
  }

  function fetchVenues(o, miles) {
    var body = "data=" + encodeURIComponent(overpassQuery(o, miles));
    var i = 0;
    function attempt() {
      return fetchJSON(OVERPASS[i], {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body
      }, 35000).catch(function (err) {
        i++;
        if (i < OVERPASS.length) return attempt();
        throw err;
      });
    }
    return attempt().then(function (json) { return (json.elements || []).map(function (el) { return toVenue(el, o); }).filter(Boolean); });
  }

  function toVenue(el, origin) {
    var t = el.tags || {};
    var lat = el.lat != null ? el.lat : el.center && el.center.lat;
    var lon = el.lon != null ? el.lon : el.center && el.center.lon;
    if (lat == null || lon == null || !t.name) return null;
    var key = t.tourism === "hotel" ? "hotel" : t.amenity;
    var type = TYPES[key];
    if (!type) return null;

    var id = el.type + "/" + el.id;
    var listed = parseInt(String(t.capacity || t["capacity:persons"] || "").replace(/[^\d]/g, ""), 10);
    var capacity, capacitySource;
    if (listed > 0) {
      capacity = listed; capacitySource = "listed";
    } else {
      var r = hash(id);
      capacity = Math.round((type.cap[0] + r * (type.cap[1] - type.cap[0])) / 5) * 5;
      if (t.outdoor_seating === "yes" || t.beer_garden === "yes") capacity = Math.round(capacity * 1.2);
      capacitySource = "estimated";
    }

    var cuisine = (t.cuisine || "").split(";")[0].trim().toLowerCase();
    var addr = [[t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), t["addr:city"]].filter(Boolean).join(", ");
    return {
      id: id, name: t.name, key: key, type: type, lat: lat, lon: lon,
      distance: haversineMiles(origin, { lat: lat, lon: lon }),
      capacity: capacity, capacitySource: capacitySource,
      cuisine: cuisine, address: addr,
      phone: t.phone || t["contact:phone"] || "",
      email: t.email || t["contact:email"] || "",
      website: t.website || t["contact:website"] || "",
      demo: false
    };
  }

  // Used only when no live venue data is reachable, so the flow can still be tried.
  function demoVenues(o, miles) {
    var names = [
      ["The Golden Fork", "restaurant", "italian"], ["Neon Taco Club", "restaurant", "mexican"],
      ["Velvet Room", "bar", ""], ["Hop & Barley", "pub", ""], ["Lantern Hall", "events_venue", ""],
      ["Riverside Community Center", "community_centre", ""], ["Sakura House", "restaurant", "japanese"],
      ["The Grand Elm Hotel", "hotel", ""], ["Disco Biscuit", "nightclub", ""], ["Prime Cut Steakhouse", "restaurant", "steak_house"],
      ["Garden Social", "biergarten", ""], ["The Loft at 5th", "events_venue", ""], ["Pizza Palace", "restaurant", "pizza"],
      ["Summit Conference Center", "conference_centre", ""]
    ];
    return names.map(function (n, i) {
      var ang = hash(n[0]) * Math.PI * 2;
      var dist = miles * (0.15 + 0.8 * hash(n[0] + i));
      var lat = o.lat + (dist / 69) * Math.cos(ang);
      var lon = o.lon + (dist / (69 * Math.cos(o.lat * Math.PI / 180))) * Math.sin(ang);
      var v = toVenue({ type: "demo", id: i, lat: lat, lon: lon, tags: { name: n[0], amenity: n[1] === "hotel" ? "" : n[1], tourism: n[1] === "hotel" ? "hotel" : "", cuisine: n[2] } }, o);
      v.demo = true;
      return v;
    });
  }

  /* ---------- pricing ---------- */

  function quoteFor(v, opts) {
    var guests = opts.guests, style = opts.style || "buffet", hours = +opts.hours || 3;
    var pp = v.type.pp[STYLE_INDEX[style]];
    if (v.key === "restaurant" && CUISINE_MULT[v.cuisine]) pp *= CUISINE_MULT[v.cuisine];
    var d = parseDate(opts.date);
    var weekend = d && (d.getDay() === 5 || d.getDay() === 6);
    var hourFactor = 1 + (hours - 3) * 0.12;
    var groupDiscount = guests > 150 ? 0.08 : guests > 75 ? 0.05 : 0;

    var fnb = Math.round(pp * guests * hourFactor);
    var lines = [{ label: STYLE_LABEL[style] + " · " + guests + " × " + money(pp * hourFactor), amount: fnb }];
    if (v.type.room) lines.push({ label: "Room / rental fee", amount: v.type.room });
    if (weekend) lines.push({ label: "Fri/Sat demand (+15%)", amount: Math.round(fnb * 0.15) });
    if (groupDiscount) lines.push({ label: "Big group discount (−" + groupDiscount * 100 + "%)", amount: -Math.round(fnb * groupDiscount) });
    var subtotal = lines.reduce(function (s, l) { return s + l.amount; }, 0);
    lines.push({ label: "Service & gratuity (20%)", amount: Math.round(subtotal * 0.2) });
    lines.push({ label: "Estimated tax (8%)", amount: Math.round(subtotal * 0.08) });
    var total = lines.reduce(function (s, l) { return s + l.amount; }, 0);
    return { lines: lines, total: total, perGuest: total / guests, deposit: Math.round(total * 0.25) };
  }

  /* ---------- address autocomplete + validation ---------- */

  // Suggestions come from Google Places (when CONFIG.googleMapsApiKey is set) or from
  // Photon, a free OpenStreetMap address search. Picking a suggestion validates the address
  // and gives us its exact coordinates.
  var addr = { selected: null, items: [], active: -1, seq: 0, timer: null, google: null, googleFailed: false, token: null };

  function loadGoogle() {
    if (addr.google) return addr.google;
    addr.google = new Promise(function (resolve, reject) {
      window.__venueHuntGoogleReady = function () {
        google.maps.importLibrary("places").then(resolve, reject);
      };
      var s = document.createElement("script");
      s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(CONFIG.googleMapsApiKey) +
        "&loading=async&v=weekly&callback=__venueHuntGoogleReady";
      s.async = true;
      s.onerror = function () { reject(new Error("Google Maps failed to load")); };
      document.head.appendChild(s);
      setTimeout(function () { reject(new Error("Google Maps timed out")); }, 10000);
    });
    return addr.google;
  }
  function useGoogle() { return !!CONFIG.googleMapsApiKey && !addr.googleFailed; }

  function googleSuggest(q) {
    return loadGoogle().then(function (places) {
      if (!addr.token) addr.token = new places.AutocompleteSessionToken();
      return places.AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: q, sessionToken: addr.token });
    }).then(function (res) {
      return (res.suggestions || []).filter(function (s) { return s.placePrediction; }).slice(0, 5).map(function (s) {
        var p = s.placePrediction;
        return {
          main: p.mainText ? p.mainText.toString() : p.text.toString(),
          sub: p.secondaryText ? p.secondaryText.toString() : "",
          label: p.text.toString(),
          resolve: function () {
            var place = p.toPlace();
            return place.fetchFields({ fields: ["formattedAddress", "location"] }).then(function () {
              addr.token = null; // a pick ends the billing session
              return { lat: place.location.lat(), lon: place.location.lng(), label: place.formattedAddress || p.text.toString() };
            });
          }
        };
      });
    });
  }

  function photonSuggest(q) {
    var url = "https://photon.komoot.io/api/?limit=5&q=" + encodeURIComponent(q);
    return fetchJSON(url, {}, 8000).then(function (json) {
      return (json.features || []).map(function (f) {
        var p = f.properties || {}, c = f.geometry.coordinates;
        var street = [p.housenumber, p.street].filter(Boolean).join(" ");
        var main = p.name || street || p.city || p.state || "";
        var subParts = [p.name && street && p.name !== street ? street : "", p.name !== p.city ? p.city : "", p.state, p.postcode, p.country];
        var sub = subParts.filter(Boolean).join(", ");
        var label = [main, sub].filter(Boolean).join(", ");
        return { main: main, sub: sub, label: label, resolve: function () { return Promise.resolve({ lat: c[1], lon: c[0], label: label }); } };
      }).filter(function (s) { return s.main; });
    });
  }

  function suggest(q) {
    if (useGoogle()) {
      return googleSuggest(q).catch(function () { addr.googleFailed = true; return photonSuggest(q); });
    }
    return photonSuggest(q);
  }

  function setAddrStatus(text, cls) {
    var el = $("addr-status");
    el.textContent = text || "";
    el.className = "addr-status" + (cls ? " " + cls : "");
  }

  function closeSuggestions() {
    $("address-list").hidden = true;
    $("address").setAttribute("aria-expanded", "false");
    $("address").removeAttribute("aria-activedescendant");
    addr.active = -1;
  }

  function renderSuggestions(items, emptyText) {
    addr.items = items;
    addr.active = -1;
    var ul = $("address-list");
    if (!items.length && !emptyText) { closeSuggestions(); return; }
    ul.innerHTML = items.map(function (s, i) {
      return '<li role="option" id="addr-opt-' + i + '" data-i="' + i + '" aria-selected="false"><span class="s-pin" aria-hidden="true">📍</span>' +
        '<span><span class="s-main">' + esc(s.main) + '</span><br><span class="s-sub">' + esc(s.sub) + "</span></span></li>";
    }).join("") + (items.length
      ? '<li class="s-credit" aria-hidden="true">' + (useGoogle() ? "powered by Google" : "© OpenStreetMap") + "</li>"
      : '<li class="s-empty">' + esc(emptyText) + "</li>");
    ul.hidden = false;
    $("address").setAttribute("aria-expanded", "true");
  }

  function moveActive(delta) {
    if (!addr.items.length) return;
    addr.active = (addr.active + delta + addr.items.length) % addr.items.length;
    $("address-list").querySelectorAll('[role="option"]').forEach(function (li, i) {
      li.setAttribute("aria-selected", i === addr.active ? "true" : "false");
    });
    $("address").setAttribute("aria-activedescendant", "addr-opt-" + addr.active);
  }

  function pickSuggestion(i) {
    var s = addr.items[i];
    if (!s) return Promise.resolve(null);
    closeSuggestions();
    $("address").value = s.label;
    setAddrStatus("Checking address…");
    return s.resolve().then(function (place) {
      addr.selected = place;
      $("address").value = place.label;
      setAddrStatus("✓ Verified address", "ok");
      return place;
    }).catch(function () {
      addr.selected = null;
      setAddrStatus("We couldn't verify that one. Try another suggestion.", "warn");
      return null;
    });
  }

  function onAddressInput() {
    addr.selected = null;
    setAddrStatus("");
    clearTimeout(addr.timer);
    var q = $("address").value.trim();
    if (q.length < 3) { closeSuggestions(); return; }
    addr.timer = setTimeout(function () {
      var seq = ++addr.seq;
      suggest(q).then(function (items) {
        if (seq !== addr.seq) return; // a newer keystroke won
        renderSuggestions(items, "No matches yet. Keep typing or add a city.");
      }).catch(function () {
        if (seq === addr.seq) closeSuggestions();
      });
    }, 250);
  }

  function onAddressKey(e) {
    var open = !$("address-list").hidden;
    if (e.key === "ArrowDown") { e.preventDefault(); if (open) moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (open) moveActive(-1); }
    else if (e.key === "Enter" && open && addr.active >= 0) { e.preventDefault(); pickSuggestion(addr.active); }
    else if (e.key === "Escape") { closeSuggestions(); }
  }

  // Resolve whatever is in the box to a validated place, for searches run without picking a suggestion.
  function resolveAddress(text) {
    if (addr.selected) return Promise.resolve(addr.selected);
    var m = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (m) return Promise.resolve({ lat: +m[1], lon: +m[2], label: text });
    return suggest(text).then(function (items) {
      if (!items.length) throw new Error("NOT_FOUND");
      addr.items = items;
      return pickSuggestion(0).then(function (place) {
        if (!place) throw new Error("NOT_FOUND");
        setAddrStatus("✓ Using the closest match: " + place.label, "ok");
        return place;
      });
    });
  }

  /* ---------- search ---------- */

  function readSearch() {
    var radius = +(document.querySelector('input[name="radius"]:checked') || {}).value || 5;
    return {
      address: $("address").value.trim(),
      radius: radius,
      guests: parseInt($("guests").value, 10),
      date: $("date").value,
      kind: $("kind").value
    };
  }

  function validateSearch(s) {
    if (!s.address) return "Add an address so we know where to look.";
    if (!(s.guests > 0)) return "How many people are coming? Enter a number of attendees.";
    if (s.guests > 2000) return "That's a festival! Enter 2,000 attendees or fewer.";
    if (!parseDate(s.date)) return "Pick a party date.";
    if (daysOut(s.date) < 0) return "That date already happened. Pick a future date.";
    return "";
  }

  function updateDateNotice() {
    var s = $("date").value, el = $("date-notice"), n = daysOut(s);
    if (n === null || n < 0) { el.hidden = true; return; }
    el.hidden = false;
    if (n >= MIN_DAYS_NOTICE) {
      el.className = "notice ok";
      el.textContent = "🎉 " + n + " days out. You can request availability and a quote from any venue below.";
    } else {
      el.className = "notice";
      el.textContent = "⏳ Your party is " + (n === 0 ? "today" : n === 1 ? "tomorrow" : "in " + n + " days") +
        ". Venues need at least " + MIN_DAYS_NOTICE + " days' notice, so availability and quote requests open for parties on " +
        prettyDate(earliestRequestDate()) + " or later. You can still browse venues.";
    }
  }

  // Venues are fetched in growing rings (each ring re-queries the full circle up to that
  // distance), so the first 5 closest show quickly even for a 10-mile search.
  function radiusSteps(r) {
    if (r <= 1) return [1];
    if (r <= 5) return [1.5, 5];
    return [1.5, 4, 10];
  }

  function onSearch(e) {
    e.preventDefault();
    closeSuggestions();
    var s = readSearch();
    var err = validateSearch(s);
    $("form-error").hidden = !err;
    $("form-error").textContent = err;
    if (err) return;

    state.search = s;
    state.venues = [];
    state.byId = {};
    state.steps = radiusSteps(s.radius);
    state.stepIndex = 0;
    state.covered = 0;
    state.usedDemo = false;
    state.shownCount = PAGE_SIZE;
    $("results").hidden = true;
    setLoading(true, "Checking the address…");
    resolveAddress(s.address)
      .then(function (o) {
        state.origin = o;
        setLoading(true, "Scouting the closest venues…");
        return loadUntil(PAGE_SIZE, true);
      })
      .then(function () { render(true); })
      .catch(function (err) {
        $("form-error").hidden = false;
        $("form-error").textContent = err && err.message === "NOT_FOUND"
          ? "We couldn't find that address. Pick one of the suggestions as you type."
          : "We couldn't look up that address right now. Check your connection and try again.";
      })
      .finally(function () { setLoading(false); });
  }

  function hasMoreRings() { return !state.usedDemo && state.stepIndex < state.steps.length; }

  // Fetch rings until at least `need` matching venues are loaded or the radius is exhausted.
  function loadUntil(need, first) {
    if (filtered().length >= need || !hasMoreRings()) return Promise.resolve();
    var miles = state.steps[state.stepIndex];
    return fetchVenues(state.origin, miles).then(function (venues) {
      venues.forEach(function (v) {
        if (!state.byId[v.id]) { state.byId[v.id] = v; state.venues.push(v); }
      });
      state.covered = miles;
      state.stepIndex++;
      return loadUntil(need, false);
    }, function (err) {
      if (!first || state.venues.length) throw err;
      // No live data at all: fall back to sample venues so the flow can still be tried.
      state.usedDemo = true;
      state.venues = demoVenues(state.origin, state.search.radius);
      state.covered = state.search.radius;
      state.stepIndex = state.steps.length;
    });
  }

  function onMore() {
    var btn = $("more-btn");
    state.shownCount += PAGE_SIZE;
    if (filtered().length >= state.shownCount || !hasMoreRings()) { render(false); return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="mini-spin" aria-hidden="true"></span> Finding more venues…';
    $("more-note").textContent = "";
    loadUntil(state.shownCount, false)
      .then(function () { render(false); })
      .catch(function () {
        state.shownCount -= PAGE_SIZE;
        $("more-note").textContent = "Couldn't load more venues right now. Try again in a moment.";
      })
      .finally(function () { btn.disabled = false; btn.textContent = "Show 5 more venues"; });
  }

  function filtered() {
    var s = state.search;
    var seen = {};
    var list = state.venues.filter(function (v) {
      if (v.distance > Math.min(s.radius, state.covered)) return false;
      if (v.capacity < s.guests) return false;
      if (s.kind !== "all" && v.type.group !== s.kind) return false;
      var k = v.name.toLowerCase() + "|" + v.lat.toFixed(3) + v.lon.toFixed(3);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    var sort = $("sort").value;
    list.forEach(function (v) { v.quickQuote = quoteFor(v, { guests: s.guests, style: "buffet", hours: 3, date: s.date }); });
    list.sort(function (a, b) {
      if (sort === "capacity") return b.capacity - a.capacity;
      if (sort === "price") return a.quickQuote.total - b.quickQuote.total;
      return a.distance - b.distance;
    });
    return list;
  }

  function render(scroll) {
    var s = state.search;
    var list = filtered();
    var shown = list.slice(0, state.shownCount);
    var allowed = canRequest(s.date);
    var more = list.length > shown.length || hasMoreRings();

    $("results").hidden = false;
    $("results-title").textContent = list.length
      ? "Spots that fit " + s.guests + " guests"
      : "No spots fit " + s.guests + " guests (yet)";
    $("results-sub").textContent =
      (state.usedDemo ? "⚠️ Live venue data didn't load, so these are sample venues to try the flow with. " : "") +
      "Within " + s.radius + " mi of " + state.origin.label.split(",").slice(0, 3).join(",") +
      " · " + prettyDate(s.date) + " · showing " + shown.length + (more ? "" : " of " + list.length);

    var ul = $("venue-list");
    if (!shown.length) {
      ul.innerHTML = '<li class="empty card"><strong>Nothing big enough nearby 🫠</strong>' +
        "Try a wider radius, a different venue type, or a smaller guest count.</li>";
    } else {
      ul.innerHTML = shown.map(function (v) { return venueCard(v, allowed); }).join("");
    }
    $("more-btn").hidden = !more;
    $("more-note").textContent = !more && shown.length ? "That's every spot we found within " + s.radius + " mi." : "";
    drawMap(shown, scroll);
    if (scroll) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function venueCard(v, allowed) {
    var capTag = v.capacitySource === "listed"
      ? '<span class="tag cap">👥 Up to ' + v.capacity + " guests</span>"
      : '<span class="tag cap">👥 ~' + v.capacity + ' guests</span><span class="tag est">estimated capacity</span>';
    var cuisine = v.cuisine ? '<span class="tag">' + esc(v.cuisine.replace(/_/g, " ")) + "</span>" : "";
    var meta = [v.type.label, v.distance.toFixed(1) + " mi away", v.address].filter(Boolean).map(esc).join(" · ");
    var btn = allowed
      ? '<button class="pill primary small" data-request="' + esc(v.id) + '">Request availability &amp; quote</button>'
      : '<button class="pill primary small" disabled>Request availability &amp; quote</button>' +
        '<span class="why">Needs ' + MIN_DAYS_NOTICE + "+ days' notice</span>";
    var site = v.website ? '<a class="pill ghost small" href="' + esc(safeUrl(v.website)) + '" target="_blank" rel="noopener">Website ↗</a>' : "";
    return '<li class="venue card" id="v-' + esc(v.id) + '" data-id="' + esc(v.id) + '">' +
      '<div class="emoji" aria-hidden="true">' + v.type.emoji + "</div>" +
      "<div><h3>" + esc(v.name) + '</h3><p class="meta">' + meta + "</p>" +
      '<div class="tags">' + capTag + cuisine + '<span class="tag">from ~' + money(v.quickQuote.perGuest) + "/guest</span></div>" +
      '<div class="venue-actions">' + btn + site + "</div></div></li>";
  }

  function safeUrl(u) {
    u = String(u).trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
  }

  /* ---------- map ---------- */

  function drawMap(list, refit) {
    if (!window.L) { $("map").hidden = true; $("map").parentNode.classList.add("no-map"); return; }
    if (!state.map) {
      state.map = L.map("map", { scrollWheelZoom: false });
      // Leaflet needs a view before any layer is added, or drawing the circle throws.
      state.map.setView([state.origin.lat, state.origin.lon], 13);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, subdomains: "abcd",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      }).addTo(state.map);
    }
    if (state.layer) state.layer.remove();
    state.layer = L.layerGroup().addTo(state.map);
    state.markers = {};
    var o = state.origin;
    L.marker([o.lat, o.lon], { icon: L.divIcon({ className: "", html: '<div class="map-home"></div>', iconSize: [18, 18] }), title: "Your address" }).addTo(state.layer);
    var circle = L.circle([o.lat, o.lon], { radius: state.search.radius * MILE_M, color: "#ff4fb8", weight: 1.5, fillOpacity: 0.05 }).addTo(state.layer);
    list.forEach(function (v) {
      var m = L.marker([v.lat, v.lon], {
        icon: L.divIcon({ className: "", html: '<div class="map-pin">' + v.type.emoji + "</div>", iconSize: [24, 24], iconAnchor: [12, 12] }),
        title: v.name
      }).addTo(state.layer);
      m.bindPopup("<strong>" + esc(v.name) + "</strong><br>" + esc(v.type.label) + " · " + v.distance.toFixed(1) + " mi");
      m.on("click", function () { highlight(v.id, true); });
      state.markers[v.id] = m;
    });
    setTimeout(function () {
      state.map.invalidateSize();
      if (refit) state.map.fitBounds(circle.getBounds(), { padding: [10, 10] });
    }, 50);
  }

  function highlight(id, scroll) {
    document.querySelectorAll(".venue.active").forEach(function (el) { el.classList.remove("active"); });
    var el = document.getElementById("v-" + id);
    if (el) { el.classList.add("active"); if (scroll) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
  }

  /* ---------- request + quote ---------- */

  function openRequest(id) {
    var v = state.venues.find(function (x) { return x.id === id; });
    if (!v || !canRequest(state.search.date)) return;
    state.active = v;
    $("request-form").hidden = false;
    $("quote-view").hidden = true;
    $("req-error").hidden = true;
    $("req-venue-type").textContent = v.type.emoji + " " + v.type.label.toLowerCase();
    $("req-venue-name").textContent = v.name;
    $("req-venue-meta").textContent = [v.distance.toFixed(1) + " mi away", v.address,
      (v.capacitySource === "listed" ? "holds up to " : "holds ~") + v.capacity].filter(Boolean).join(" · ");
    $("req-date").min = earliestRequestDate();
    $("req-date").value = state.search.date;
    $("req-guests").value = state.search.guests;
    $("req-guests").max = v.capacity;
    if (v.type.group === "bar") $("req-style").value = "drinks";
    else if (v.key === "restaurant") $("req-style").value = "seated";
    else $("req-style").value = "buffet";
    $("request-dialog").showModal();
  }

  function submitRequest() {
    var v = state.active;
    var req = {
      id: "req_" + Date.now().toString(36),
      venueId: v.id, venueName: v.name, venueType: v.type.label, venueAddress: v.address,
      venuePhone: v.phone, venueEmail: v.email, venueWebsite: v.website, demo: v.demo,
      date: $("req-date").value, time: $("req-time").value, hours: +$("req-hours").value,
      guests: parseInt($("req-guests").value, 10), style: $("req-style").value,
      name: $("req-name").value.trim(), email: $("req-email").value.trim(), notes: $("req-notes").value.trim(),
      createdAt: new Date().toISOString(), status: "Awaiting venue"
    };

    var err = "";
    if (!parseDate(req.date)) err = "Pick a date for the party.";
    else if (!canRequest(req.date)) err = "Venues need at least " + MIN_DAYS_NOTICE + " days' notice. Pick " + prettyDate(earliestRequestDate()) + " or later.";
    else if (!req.time) err = "Add a start time.";
    else if (!(req.guests > 0)) err = "Enter how many guests are coming.";
    else if (req.guests > v.capacity) err = "This venue holds about " + v.capacity + ". Lower the guest count or pick a bigger spot.";
    else if (!req.name) err = "Add your name so the venue knows who's asking.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.email)) err = "Add a valid email so the venue can reply.";
    $("req-error").hidden = !err;
    $("req-error").textContent = err;
    if (err) return;

    req.quote = quoteFor(v, req);
    saveRequest(req);
    if (CONFIG.requestEndpoint) {
      fetch(CONFIG.requestEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) })
        .catch(function () { /* request is still saved locally */ });
    }
    showQuote(req);
  }

  function requestText(req) {
    return "Hi " + req.venueName + "!\n\n" +
      "I'd like to check availability and get a quote for a private party:\n" +
      "• Date: " + prettyDate(req.date) + " at " + req.time + " (" + req.hours + " hours)\n" +
      "• Guests: " + req.guests + "\n" +
      "• Food & drink: " + STYLE_LABEL[req.style] + "\n" +
      (req.notes ? "• Notes: " + req.notes + "\n" : "") +
      "\nAre you available, and what would the total cost be?\n\nThanks,\n" + req.name + "\n" + req.email;
  }

  function showQuote(req) {
    $("request-form").hidden = true;
    $("quote-view").hidden = false;
    $("quote-title").textContent = req.venueName;
    $("quote-sub").textContent = prettyDate(req.date) + " · " + req.time + " · " + req.hours + " hrs · " + req.guests + " guests";
    var rows = req.quote.lines.map(function (l) {
      return "<tr><td>" + esc(l.label) + "</td><td>" + (l.amount < 0 ? "−" + money(-l.amount) : money(l.amount)) + "</td></tr>";
    }).join("");
    rows += '<tr class="total"><td>Estimated total</td><td>' + money(req.quote.total) + "</td></tr>";
    rows += '<tr><td class="muted">Per guest · typical 25% deposit</td><td class="muted">' + money(req.quote.perGuest) + " · " + money(req.quote.deposit) + "</td></tr>";
    $("quote-table").innerHTML = rows;

    var subject = "Party inquiry: " + req.guests + " guests on " + prettyDate(req.date);
    var actions = [];
    if (req.demo) {
      actions.push('<span class="fine">This is a sample venue, so there\'s nobody to contact. Run a search with live data to reach real venues.</span>');
    } else {
      if (req.venueEmail) actions.push('<a class="pill primary small" href="mailto:' + esc(req.venueEmail) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(requestText(req)) + '">✉️ Email the venue</a>');
      if (req.venuePhone) actions.push('<a class="pill ghost small" href="tel:' + esc(req.venuePhone.replace(/[^\d+]/g, "")) + '">📞 ' + esc(req.venuePhone) + "</a>");
      if (req.venueWebsite) actions.push('<a class="pill ghost small" href="' + esc(safeUrl(req.venueWebsite)) + '" target="_blank" rel="noopener">🌐 Book on their site</a>');
      if (!actions.length) actions.push('<a class="pill ghost small" target="_blank" rel="noopener" href="https://www.google.com/search?q=' + encodeURIComponent(req.venueName + " " + (req.venueAddress || "")) + '">🔎 Find their contact</a>');
    }
    actions.push('<button class="pill ghost small" type="button" id="copy-req">📋 Copy request</button>');
    $("quote-actions").innerHTML = actions.join("");
    var copyBtn = $("copy-req");
    copyBtn.addEventListener("click", function () {
      var done = function () { copyBtn.textContent = "✅ Copied"; };
      if (navigator.clipboard) navigator.clipboard.writeText(requestText(req)).then(done, function () { copyBtn.textContent = "Copy failed"; });
    });
  }

  function loadRequests() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return state.memRequests || []; }
  }
  function saveRequest(req) {
    var all = loadRequests();
    all.unshift(req);
    state.memRequests = all;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(0, 50))); } catch (e) { /* storage unavailable */ }
    updateReqCount();
  }
  function updateReqCount() { $("req-count").textContent = loadRequests().length; }

  function openRequests() {
    var all = loadRequests();
    $("req-list").innerHTML = all.length ? all.map(function (r) {
      return '<li><div class="row"><strong>' + esc(r.venueName) + '</strong><span class="status">' + esc(r.status) + "</span></div>" +
        '<div class="muted">' + esc(prettyDate(r.date)) + " · " + esc(r.time) + " · " + r.guests + " guests · " + esc(STYLE_LABEL[r.style] || "") + "</div>" +
        "<div>Estimate: <strong>" + money(r.quote.total) + "</strong> (" + money(r.quote.perGuest) + "/guest)</div></li>";
    }).join("") : '<li class="muted">No requests yet. Find a venue and ask for a quote!</li>';
    $("requests-dialog").showModal();
  }

  /* ---------- wire up ---------- */

  function init() {
    var d = todayLocal();
    $("date").min = toISO(d);
    d.setDate(d.getDate() + 14);
    $("date").value = toISO(d);
    updateDateNotice();
    updateReqCount();

    $("search-form").addEventListener("submit", onSearch);
    $("more-btn").addEventListener("click", onMore);
    $("address").addEventListener("input", onAddressInput);
    $("address").addEventListener("keydown", onAddressKey);
    $("address").addEventListener("blur", function () { setTimeout(closeSuggestions, 150); });
    $("address-list").addEventListener("mousedown", function (e) {
      var li = e.target.closest("[data-i]");
      if (li) { e.preventDefault(); pickSuggestion(+li.getAttribute("data-i")); }
    });
    $("date").addEventListener("change", function () {
      updateDateNotice();
      if (state.search && !$("results").hidden) { state.search.date = $("date").value; render(); }
    });
    $("sort").addEventListener("change", function () { if (state.search) render(); });
    $("venue-list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-request]");
      if (b) { openRequest(b.getAttribute("data-request")); return; }
      var card = e.target.closest(".venue");
      if (card && !e.target.closest("a,button")) {
        var id = card.getAttribute("data-id"), m = state.markers[id];
        highlight(id, false);
        if (m && state.map) { state.map.setView(m.getLatLng(), Math.max(state.map.getZoom(), 15)); m.openPopup(); }
      }
    });
    $("req-submit").addEventListener("click", submitRequest);
    $("quote-close").addEventListener("click", function () { $("request-dialog").close(); });
    $("request-close").addEventListener("click", function () { $("request-dialog").close(); });
    $("request-form").addEventListener("submit", function (e) { e.preventDefault(); submitRequest(); });
    // Clicking the dimmed backdrop closes either dialog (Esc already does).
    ["request-dialog", "requests-dialog"].forEach(function (id) {
      $(id).addEventListener("click", function (e) { if (e.target === e.currentTarget) e.currentTarget.close(); });
    });
    $("my-requests-btn").addEventListener("click", openRequests);
    $("requests-close").addEventListener("click", function () { $("requests-dialog").close(); });
  }

  // Exposed for testing.
  window.VenueHunt = { daysOut: daysOut, canRequest: canRequest, quoteFor: quoteFor, TYPES: TYPES };
  init();
})();
