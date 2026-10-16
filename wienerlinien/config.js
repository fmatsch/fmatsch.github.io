// Where the API lives. On fmatsch.ist the page is static (GitHub Pages) and the API runs on the server.
window.WL_API = /(^|\.)fmatsch\.ist$/.test(location.hostname) ? 'https://www.depes.ch/wl-api' : '';
