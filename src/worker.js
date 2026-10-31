/**
 * VenueSearch Worker.
 *
 * Serves the static site from ./public and adds one API route:
 *
 *   GET /api/contact?name=&lat=&lon=&address=&website=&email=&phone=
 *
 *   GET /api/venues?lat=&lon=&miles=
 *
 * A backup route for venue search. The page asks the public OpenStreetMap (Overpass) servers
 * directly first; when they refuse or time out, it asks here. This asks the same servers from
 * Cloudflare (trying each mirror in turn) and caches answers for a day. If they all fail and a
 * GOOGLE_PLACES_KEY secret is set, Google Places Nearby Search is used instead.
 *
 * /api/contact finds a venue's public contact details so a quote request can be sent straight to them:
 *   1. Any email/phone already known from OpenStreetMap (passed in by the page).
 *   2. If the venue has no website and a GOOGLE_PLACES_KEY secret is set, Google Places
 *      (Text Search) is asked for the website and phone number.
 *   3. The venue's website is fetched (home page plus up to 3 contact / events / private-dining
 *      pages) and email addresses, phone numbers and the best contact page are pulled out.
 * Results are cached for a week.
 */

const UA = "Mozilla/5.0 (compatible; VenueSearchBot/1.0; +https://github.com/Hisha1/VenueSearch)";
const LOOKUP_BUDGET_MS = 9000;
const PAGE_TIMEOUT_MS = 5000;
const MAX_HTML = 1_500_000;
const CACHE_SECONDS = 7 * 24 * 3600;

const LINK_WORDS = /(contact|private|event|part(y|ies)|book|reserv|group|cater|inquir|enquir|celebrat|function)/i;
const GOOD_LOCAL = /(event|private|party|parties|book|reserv|group|cater|function|sales|celebrat)/i;
const OK_LOCAL = /(info|hello|contact|manager|office|enquir|inquir|admin|team|gm)/i;
const BAD_EMAIL_DOMAIN = /(example\.(com|org)|domain\.com|email\.com|yourdomain|sentry|wixpress\.com|wix\.com|squarespace\.com|godaddy\.com|schema\.org|w3\.org|cloudflare\.com|googleapis\.com|mailchimp|sentry\.io)$/i;
const BAD_EMAIL_LOCAL = /^(no-?reply|donotreply|example|user|name|email|test|privacy|abuse|webmaster|postmaster)$/i;
const ASSET_EXT = /\.(png|jpe?g|gif|webp|svg|css|js|ico|avif|woff2?)$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/contact") return handleContact(request, env, ctx);
    if (url.pathname === "/api/venues") return handleVenues(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};

async function handleContact(request, env, ctx) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const q = new URL(request.url).searchParams;
  const input = {
    name: (q.get("name") || "").slice(0, 200).trim(),
    address: (q.get("address") || "").slice(0, 300).trim(),
    lat: parseFloat(q.get("lat")),
    lon: parseFloat(q.get("lon")),
    website: (q.get("website") || "").slice(0, 500).trim(),
    email: (q.get("email") || "").slice(0, 200).trim(),
    phone: (q.get("phone") || "").slice(0, 60).trim()
  };
  if (!input.name) return json({ error: "name is required" }, 400);

  const cacheKey = new Request("https://cache.venuesearch.internal/contact?" + new URLSearchParams(
    Object.entries(input).map(([k, v]) => [k, String(v)]).sort()
  ));
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const result = await lookupContact(input, env);
  const res = json(result, 200, { "Cache-Control": "public, max-age=" + CACHE_SECONDS });
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export async function lookupContact(input, env = {}) {
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  const found = { emails: new Map(), phones: new Set(), contactPage: null };
  let website = normalizeSite(input.website);
  const sources = [];

  if (input.email) addEmail(found, input.email, "openstreetmap");
  if (input.phone) found.phones.add(input.phone);
  if (input.email || input.phone) sources.push("openstreetmap");

  if (!website && env.GOOGLE_PLACES_KEY && isFinite(input.lat) && isFinite(input.lon)) {
    const g = await googlePlace(input, env.GOOGLE_PLACES_KEY, deadline).catch(() => null);
    if (g) {
      sources.push("google");
      if (g.website) website = normalizeSite(g.website);
      if (g.phone) found.phones.add(g.phone);
    }
  }

  if (website) {
    const crawled = await crawl(website, deadline).catch(() => null);
    if (crawled) {
      sources.push("website");
      crawled.emails.forEach((src, e) => addEmail(found, e, src));
      crawled.phones.forEach((p) => found.phones.add(p));
      found.contactPage = crawled.contactPage;
    }
  }

  const siteHost = website ? hostOf(website) : "";
  const emails = [...found.emails.entries()]
    .map(([email, source]) => ({ email, source, score: scoreEmail(email, source, siteHost) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ email, source }) => ({ email, source }));

  return {
    emails,
    phones: [...found.phones].slice(0, 3),
    website: website || null,
    contactPage: found.contactPage,
    sources
  };
}

/* ---------- venues (backup route) ---------- */

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const VENUE_BUDGET_MS = 20000;
const KEEP_TAGS = ["name", "amenity", "tourism", "capacity", "capacity:persons", "cuisine", "outdoor_seating", "beer_garden",
  "addr:housenumber", "addr:street", "addr:city", "phone", "contact:phone", "email", "contact:email", "website", "contact:website"];

async function handleVenues(request, env, ctx) {
  const q = new URL(request.url).searchParams;
  const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon")), miles = parseFloat(q.get("miles"));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && miles > 0 && miles <= 10.5)) {
    return json({ error: "lat, lon and miles (up to 10) are required" }, 400);
  }
  const key = new Request(`https://cache.venuesearch.internal/venues?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&miles=${miles}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const deadline = Date.now() + VENUE_BUDGET_MS;
  let elements = await overpassVenues(lat, lon, miles, deadline);
  let source = "openstreetmap";
  if (!elements && env.GOOGLE_PLACES_KEY) {
    elements = await googleNearby(lat, lon, miles, env.GOOGLE_PLACES_KEY, deadline).catch(() => null);
    source = "google";
  }
  if (!elements) return json({ error: "Venue servers are busy. Try again shortly." }, 503);
  const res = json({ source, elements }, 200, { "Cache-Control": "public, max-age=86400" });
  if (cache && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export function overpassQuery(lat, lon, miles) {
  const around = `(around:${Math.round(miles * 1609.344)},${lat},${lon})`;
  return "[out:json][timeout:15];(" +
    `nwr["amenity"~"^(restaurant|bar|pub|biergarten|nightclub|events_venue|community_centre|conference_centre)$"]["name"]${around};` +
    `nwr["tourism"="hotel"]["name"]${around};` +
    ");out center tags 800;";
}

async function overpassVenues(lat, lon, miles, deadline) {
  const body = "data=" + encodeURIComponent(overpassQuery(lat, lon, miles));
  for (const url of OVERPASS) {
    const left = deadline - Date.now();
    if (left < 1000) break;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(Math.min(9000, left))
      });
      if (!res.ok) continue;
      const data = await res.json();
      const els = data.elements || [];
      if (!els.length && data.remark && /error|timed out|out of memory/i.test(data.remark)) continue;
      return els.map((el) => {
        const tags = {};
        for (const k of KEEP_TAGS) if (el.tags && el.tags[k] != null) tags[k] = el.tags[k];
        return { type: el.type, id: el.id, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, tags };
      });
    } catch {
      /* try the next mirror */
    }
  }
  return null;
}

const GOOGLE_TYPE_MAP = {
  restaurant: "restaurant", bar: "bar", pub: "pub", night_club: "nightclub", event_venue: "events_venue",
  banquet_hall: "events_venue", wedding_venue: "events_venue", convention_center: "conference_centre",
  community_center: "community_centre", hotel: "hotel"
};

async function googleNearby(lat, lon, miles, key, deadline) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.types,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber"
    },
    body: JSON.stringify({
      includedTypes: ["restaurant", "bar", "night_club", "event_venue", "banquet_hall", "convention_center", "community_center"],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: Math.min(50000, miles * 1609.344) } }
    }),
    signal: AbortSignal.timeout(Math.max(1000, Math.min(8000, deadline - Date.now())))
  });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.places || []).map((p) => {
    const t = (p.types || []).find((x) => GOOGLE_TYPE_MAP[x]);
    const kind = GOOGLE_TYPE_MAP[t] || "restaurant";
    const tags = {
      name: p.displayName && p.displayName.text,
      website: p.websiteUri || undefined,
      phone: p.nationalPhoneNumber || undefined,
      "addr:street": (p.formattedAddress || "").split(",")[0] || undefined
    };
    if (kind === "hotel") tags.tourism = "hotel"; else tags.amenity = kind;
    return { type: "google", id: p.id, lat: p.location.latitude, lon: p.location.longitude, tags };
  }).filter((e) => e.tags.name);
}

/* ---------- Google Places (optional) ---------- */

async function googlePlace(input, key, deadline) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.websiteUri,places.nationalPhoneNumber"
    },
    body: JSON.stringify({
      textQuery: [input.name, input.address].filter(Boolean).join(", "),
      maxResultCount: 1,
      locationBias: { circle: { center: { latitude: input.lat, longitude: input.lon }, radius: 300 } }
    }),
    signal: AbortSignal.timeout(Math.max(500, Math.min(4000, deadline - Date.now())))
  });
  if (!res.ok) return null;
  const data = await res.json();
  const p = data.places && data.places[0];
  return p ? { website: p.websiteUri || "", phone: p.nationalPhoneNumber || "" } : null;
}

/* ---------- website crawl ---------- */

async function crawl(site, deadline) {
  const home = await getPage(site, deadline);
  if (!home) return null;
  const out = extract(home.html);
  const links = contactLinks(home.html, home.url).slice(0, 3);
  const pages = await Promise.all(links.map((l) => getPage(l, deadline)));
  for (const p of pages) {
    if (!p) continue;
    const more = extract(p.html);
    more.emails.forEach((src, e) => { if (!out.emails.has(e)) out.emails.set(e, src); });
    more.phones.forEach((ph) => out.phones.add(ph));
  }
  out.contactPage = links[0] || null;
  return out;
}

async function getPage(url, deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 400 || !safeUrl(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, remaining))
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (type && !/html|xml|text\/plain/i.test(type)) return null;
    const html = (await res.text()).slice(0, MAX_HTML);
    return { html, url: res.url || url };
  } catch {
    return null;
  }
}

export function extract(html) {
  const emails = new Map();
  const phones = new Set();
  const add = (e) => { const c = cleanEmail(e); if (c && !emails.has(c)) emails.set(c, "website"); };

  // Cloudflare email obfuscation: data-cfemail="<hex>" (first byte is the XOR key)
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) add(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"'?]+)/gi)) {
    try { add(decodeURIComponent(m[1])); } catch { add(m[1]); }
  }
  const text = html
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, "@")
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, ".")
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
  for (const m of text.matchAll(/[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}/gi)) add(m[0]);

  for (const m of html.matchAll(/href\s*=\s*["']\s*tel:([^"']+)/gi)) {
    let p = m[1];
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    p = p.replace(/[^\d+()\-. ]/g, "").trim();
    if (p.replace(/\D/g, "").length >= 7) phones.add(p);
  }
  for (const m of html.matchAll(/"telephone"\s*:\s*"([^"]{7,30})"/gi)) phones.add(m[1].trim());

  return { emails, phones, contactPage: null };
}

export function contactLinks(html, base) {
  const baseHost = hostOf(base);
  const scored = new Map();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = m[1].trim();
    const label = m[2].replace(/<[^>]+>/g, " ");
    if (/^(mailto|tel|javascript|sms):/i.test(href)) continue;
    if (!LINK_WORDS.test(href) && !LINK_WORDS.test(label)) continue;
    let abs;
    try { abs = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol) || hostOf(abs.href) !== baseHost) continue;
    if (ASSET_EXT.test(abs.pathname) || /\.pdf$/i.test(abs.pathname)) continue;
    abs.hash = "";
    const key = abs.href;
    const s = /contact/i.test(href + label) ? 3 : /private|event|part/i.test(href + label) ? 2 : 1;
    if (!scored.has(key) || scored.get(key) < s) scored.set(key, s);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

/* ---------- helpers ---------- */

function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return "";
  }
}

export function cleanEmail(raw) {
  const e = String(raw || "").trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (e.length > 100 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e)) return "";
  const [local, domain] = e.split("@");
  if (ASSET_EXT.test(e) || BAD_EMAIL_DOMAIN.test(domain) || BAD_EMAIL_LOCAL.test(local)) return "";
  if (/^[0-9a-f]{16,}$/.test(local)) return ""; // tracking ids, e.g. Sentry DSNs
  return e;
}

function addEmail(found, email, source) {
  const c = cleanEmail(email);
  if (c && !found.emails.has(c)) found.emails.set(c, source);
}

function scoreEmail(email, source, siteHost) {
  const [local, domain] = email.split("@");
  let s = 0;
  if (siteHost && (domain === siteHost || siteHost.endsWith("." + domain) || domain.endsWith("." + siteHost))) s += 10;
  if (GOOD_LOCAL.test(local)) s += 5;
  else if (OK_LOCAL.test(local)) s += 2;
  if (source === "openstreetmap") s += 3;
  return s;
}

function normalizeSite(u) {
  u = String(u || "").trim().split(/[;\s]/)[0];
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return safeUrl(u) ? u : "";
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

function safeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return false; // bare IPs
    return true;
  } catch {
    return false;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers)
  });
}
