// Build-time values beyond Vite's own (vite.config.ts `define`).

interface ImportMetaEnv {
  /** The address of Spellglass on the web, ending in '/', for the desktop app's QR code and replay
   *  links (SPELLGLASS_WEB_URL at build time); '' when it was not set. */
  readonly SPELLGLASS_WEB_URL: string;
}
