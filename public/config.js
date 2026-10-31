/* Site settings (optional).
 *
 * requestEndpoint: a URL that receives each availability/quote request as a JSON POST.
 *
 * The Google Places key is NOT set here: it is a secret on the Cloudflare Worker
 * (GOOGLE_PLACES_KEY), so it never reaches the browser. See README.md.
 */
window.VENUE_HUNT_CONFIG = Object.assign({
  requestEndpoint: ""
}, window.VENUE_HUNT_CONFIG || {});
