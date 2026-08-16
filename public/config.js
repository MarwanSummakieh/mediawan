// Frontend runtime config.
//
// API_BASE is empty when the app is served by its own Node backend (the normal
// web case — same-origin requests). A *packaged* Tizen build replaces this file
// with one that points at the deployed backend, e.g.
//   window.API_BASE = "https://your-domain.example";
// The hosted-TV build (public/index.html loaded straight from the tunnel URL)
// leaves this empty because it's already same-origin.
window.API_BASE = window.API_BASE || "";
