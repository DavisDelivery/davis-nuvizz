// health.mts
//
// The scaffold's proof-of-wiring endpoint. ZERO external calls — no NuVizz, no
// Firestore, no vendor traffic of any kind. It exists so that a 200 from
// /.netlify/functions/health confirms three things at once:
//
//   1. Netlify resolved the base directory to load-scan/
//   2. …and found the functions directory inside it
//   3. …and the esbuild bundler compiled a .mts handler for this site
//
// Keep it dependency-free. The moment this needs an import it stops being a
// clean test of the routing itself.

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  // COMMIT_REF / CONTEXT / DEPLOY_ID are BUILD-time variables. Measured on this
  // site: they are NOT present in the function runtime — a git build of commit
  // a1211d3 in the production context still reported neither. An earlier version
  // defaulted them to 'dev', which made a correct production deploy look like a
  // local one and sent us looking for a deploy bug that did not exist.
  //
  // So report null when absent rather than inventing a value, and let the PAGE
  // own build provenance: vite bakes __BUILD_COMMIT__/__BUILD_CONTEXT__ into the
  // bundle at build time, where these variables really are available. URL is
  // available at runtime and does identify the site.
  const buildVar = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

  return new Response(
    JSON.stringify({
      ok: true,
      service: 'load-scan',
      function: 'health',
      site_url: buildVar(process.env.URL),
      // Present only if Netlify ever exposes them at runtime; null here today.
      commit: buildVar(process.env.COMMIT_REF)?.slice(0, 7) ?? null,
      context: buildVar(process.env.CONTEXT),
      deploy_id: buildVar(process.env.DEPLOY_ID),
      build_stamp: 'see the app page — build vars are not readable from a function',
      node: process.version,
      now: new Date().toISOString(),
    }),
    { status: 200, headers },
  );
};
