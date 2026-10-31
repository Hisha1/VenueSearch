# VenueSearch

Find restaurants and venues big enough for your party, then request availability and get a quote.

Enter an address, a radius (< 1, < 5 or < 10 miles), the attendee count and the party date. The app looks up nearby restaurants, bars and event spaces from OpenStreetMap (Nominatim + Overpass) and keeps only those large enough for the group. Capacity comes from the OSM `capacity` tag when listed, otherwise it is estimated by venue type.

Requesting availability and a quote is only offered when the party is at least 5 days away. A request produces an itemized estimate, is saved in the browser, and can be sent to the venue by email, phone or website. To also POST requests to a backend, set `window.VENUE_HUNT_CONFIG = { requestEndpoint: "https://..." }` before `party.js` loads.

## Run locally

```bash
npx wrangler dev
```

## Hosting

Static site served by Cloudflare Workers static assets from `public/` (see `wrangler.jsonc`). Connect this repository in the Cloudflare dashboard (Workers & Pages → Create → Import a repository) and every push to `main` deploys. Or deploy by hand with `npx wrangler deploy`.
