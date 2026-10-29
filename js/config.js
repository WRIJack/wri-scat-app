/* WRI SCAT (offline) — settings shared by the page and the service worker. */
var CONFIG = {
  // The SCAT Ops API (WRIJack/wri-scat-ops, Api.js): lists, segments, STR tables; scat_submit / scat_photo.
  // Sandbox deployment while the app is in test. When the app moves to the portal, this becomes the
  // production API under a WRI account. A phone can override it for testing with
  //   localStorage.setItem('wri_scat_dev_api', '<other /exec URL>')   (remove the key to go back).
  SCAT_API: (function () {
    try { return (typeof localStorage !== 'undefined' && localStorage.getItem('wri_scat_dev_api')) || ''; } catch (e) { return ''; }
  })() || 'https://script.google.com/macros/s/AKfycbwPLsRTdRY_Iqfw5ydjxbFneB5PF9uchemsOxbOEsjvQMF4X3NZ2SsAzghf82emk6MjBg/exec',
  // Open incidents come from the Recon Apps Script's config call (read-only, same list every WRI field app
  // uses) until the SCAT API serves them through WRIServiceLib.
  API_URL: 'https://script.google.com/macros/s/AKfycbzJ9Jniz2PZ99rShnFHT_mtsug92C7W4RiOwh7hTDc2SUIBnrsSxuzcie1Y1yfRcne1/exec',
  MAX_PHOTOS: 10,          // per record (phone storage)
  PHOTO_EDGE: 1600,        // px, longest edge after downscale
  PHOTO_QUALITY: 0.8,      // JPEG
  // satellite tiles for the online map (public, no key)
  TILE_URL: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};
self.CONFIG = CONFIG;
