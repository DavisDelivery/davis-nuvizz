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

  return new Response(
    JSON.stringify({
      ok: true,
      service: 'load-scan',
      function: 'health',
      // Netlify injects these at build time; absent locally, which is fine and
      // is itself useful signal about where the response came from.
      commit: (process.env.COMMIT_REF || '').slice(0, 7) || 'dev',
      context: process.env.CONTEXT || 'dev',
      deploy_id: process.env.DEPLOY_ID || null,
      node: process.version,
      now: new Date().toISOString(),
    }),
    { status: 200, headers },
  );
};
