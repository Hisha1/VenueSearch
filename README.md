# VenueSearch

Find restaurants and venues big enough for your party, then request availability and get a quote.

## How it works

- **Address**: start typing and pick a suggestion. Suggestions come from Google Places through the Worker (the key never reaches the browser), or from free OpenStreetMap search (Photon) when no key is set. Picking one validates the address.
- **Search**: choose a radius (< 1, < 5 or < 10 miles), the attendee count and the party date. With a Google key, `/api/venues` asks Google Places for the closest restaurants, bars and event spaces in the whole radius (up to 20 of each). Without one, it uses OpenStreetMap (Overpass) in growing rings. Venues show 5 at a time with a "Show 5 more" button, and a search never runs longer than 25 seconds.
- **Capacity**: OpenStreetMap's `capacity` tag when listed; otherwise (and always for Google results, which have no capacity) estimated by venue type.
- **Contact info on every venue**: each card shows the venue's email (click to email, or copy) and phone. Google Maps does not publish emails, so `/api/contact` reads them from the venue's website (home page plus up to 3 contact, events or private-dining pages).
- **Requests**: only offered when the party is at least 5 days away. The request produces an itemized estimate, is saved in the browser, and "Send to …" opens the user's email app addressed to the venue. To also POST requests to a backend, set `requestEndpoint` in `public/config.js`.
- **No fake data**: if venues can't be loaded, the page says why and offers "Try again".

## Google Places setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and turn on billing.
2. **APIs & Services → Library** → enable **Places API (New)**.
3. **APIs & Services → Credentials → Create credentials → API key**. Edit the key: under **API restrictions** choose **Restrict key** → **Places API (New)**. Leave **Application restrictions** as **None** (the key is only used from the Worker, never the browser).
4. Optional but recommended: **Billing → Budgets & alerts** to get an email at a spending limit, and **Places API (New) → Quotas** to cap requests per day.
5. Add the key to Cloudflare as a secret named `GOOGLE_PLACES_KEY`: dashboard → **Workers & Pages → venuesearch → Settings → Variables and Secrets → Add** (type **Secret**), then deploy. Or run `npx wrangler secret put GOOGLE_PLACES_KEY`.
6. Check it: open `https://<your-site>/api/venues?lat=40.7128&lon=-74.006&miles=1&radius=1` and look for `"source":"google"`. If it says `openstreetmap`, the `warnings` field explains what Google returned.

Each search makes up to 3 Nearby Search calls (one per venue kind), and address typing uses Autocomplete sessions. Google's Places content is not cached, per its terms.

## API routes (`src/worker.js`)

- `/api/venues?lat=&lon=&radius=&miles=&kind=`: venues near a point (Google, else OpenStreetMap with a day of caching).
- `/api/autocomplete?q=&session=` and `/api/place?id=&session=`: Google address suggestions and the picked place's location (501 when no key is set, and the page falls back to Photon).
- `/api/contact?name=&lat=&lon=&address=&website=&email=&phone=`: a venue's email, phone and contact page from what's known, Google (for the website if missing) and the venue's website. Cached for a week unless Google was used.

## Run locally

```bash
npx wrangler dev
```

## Hosting

Cloudflare Workers with static assets (see `wrangler.jsonc`). Connect this repository in the Cloudflare dashboard (Workers & Pages → Create → Import a repository) and every push to `main` deploys. Or deploy by hand with `npx wrangler deploy`.
