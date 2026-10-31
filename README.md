# VenueSearch

Find restaurants and venues big enough for your party, then request availability and get a quote.

Start typing an address and pick a suggestion (Google Places if a key is set in `public/config.js`, otherwise free OpenStreetMap search via Photon); the pick validates the address. Then choose a radius (< 1, < 5 or < 10 miles), the attendee count and the party date. The app looks up nearby restaurants, bars and event spaces from OpenStreetMap (Nominatim + Overpass) and keeps only those large enough for the group. Results load 5 at a time, closest first, with a "Show 5 more" button; venues are fetched in growing rings so the first results arrive quickly. Capacity comes from the OSM `capacity` tag when listed, otherwise it is estimated by venue type.

Requesting availability and a quote is only offered when the party is at least 5 days away. A request produces an itemized estimate, is saved in the browser, and can be sent to the venue by email, phone or website. To also POST requests to a backend, set `requestEndpoint` in `public/config.js`.

## Google address suggestions (optional)

1. In Google Cloud, create a project with billing, enable **Places API (New)** and **Maps JavaScript API**, and create an API key.
2. Restrict the key to **Websites** with your domain(s), e.g. `venuesearch.<subdomain>.workers.dev/*`.
3. Put the key in `googleMapsApiKey` in `public/config.js` and push.

Leaflet 1.9.4 is vendored in `public/vendor/leaflet/` (BSD-2-Clause).

## Run locally

```bash
npx wrangler dev
```

## Hosting

Static site served by Cloudflare Workers static assets from `public/` (see `wrangler.jsonc`). Connect this repository in the Cloudflare dashboard (Workers & Pages → Create → Import a repository) and every push to `main` deploys. Or deploy by hand with `npx wrangler deploy`.
