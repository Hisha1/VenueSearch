# VenueSearch

Find restaurants and venues big enough for your party, then request availability and get a quote.

## How it works

- **Address**: start typing and pick a suggestion (Google Places if a key is set in `public/config.js`, otherwise free OpenStreetMap search via Photon). Picking one validates the address.
- **Search**: choose a radius (< 1, < 5 or < 10 miles), the attendee count and the party date. Venues come from OpenStreetMap (Overpass) and only those large enough for the group are shown. Capacity comes from the OSM `capacity` tag when listed, otherwise it is estimated by venue type.
- **Speed**: venues are fetched in growing rings, closest first, and shown 5 at a time as they arrive, with a "Show 5 more" button. A search never runs longer than 25 seconds: a slow venue server is backed up by a second one after 3 seconds, and each request gives up after 12.
- **Requests**: only offered when the party is at least 5 days away. Opening a request looks up the venue's email, phone and contact page (see below). The request produces an itemized estimate, is saved in the browser, and "Send to …" opens the user's email app addressed to the venue with the message filled in, so the venue replies straight to them. To also POST requests to a backend, set `requestEndpoint` in `public/config.js`.

## Contact lookup (`/api/contact`)

`src/worker.js` is a Cloudflare Worker that serves `public/` and answers `/api/contact`. For a venue it:

1. Uses any email/phone already listed on OpenStreetMap.
2. If the venue has no website and a `GOOGLE_PLACES_KEY` secret is set, asks Google Places for its website and phone (optional).
3. Fetches the venue's website (home page plus up to 3 contact, events or private-dining pages) and extracts email addresses (including Cloudflare-obfuscated ones), phone numbers and the contact page, ranking event/booking addresses on the venue's own domain first.

Lookups take at most about 9 seconds and are cached for a week. To enable the optional Google step:

```bash
npx wrangler secret put GOOGLE_PLACES_KEY
```

## Google address suggestions (optional)

1. In Google Cloud, create a project with billing, enable **Places API (New)** and **Maps JavaScript API**, and create an API key.
2. Restrict the key to **Websites** with your domain(s), e.g. `venuesearch.<subdomain>.workers.dev/*`.
3. Put the key in `googleMapsApiKey` in `public/config.js` and push.

## Run locally

```bash
npx wrangler dev
```

## Hosting

Cloudflare Workers with static assets (see `wrangler.jsonc`). Connect this repository in the Cloudflare dashboard (Workers & Pages → Create → Import a repository) and every push to `main` deploys. Or deploy by hand with `npx wrangler deploy`.
