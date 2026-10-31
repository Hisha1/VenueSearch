/* Site settings. Both values are optional.
 *
 * googleMapsApiKey: a Google Maps Platform browser key with the "Places API (New)" and
 *   "Maps JavaScript API" enabled. Restrict it to this site's domain (HTTP referrer) in
 *   Google Cloud. With a key, address suggestions come from Google; without one they come
 *   from OpenStreetMap (Photon), which is free and needs no key.
 *
 * requestEndpoint: a URL that receives each availability/quote request as a JSON POST.
 */
window.VENUE_HUNT_CONFIG = Object.assign({
  googleMapsApiKey: "",
  requestEndpoint: ""
}, window.VENUE_HUNT_CONFIG || {});
