const API_URL = "https://vats123691.megapbx.ru/crmapi/v1/history/json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request) {
    if (request.method !== "GET") return json({ ok: false, error: "GET only" }, 405);

    const started = Date.now();
    const url = new URL(API_URL);
    url.searchParams.set("period", "today");
    url.searchParams.set("type", "in");
    url.searchParams.set("limit", "1");

    try {
      // Deliberately omit X-API-KEY: this test checks network reachability only.
      // A 401/403 from MegaFon is a successful network-path test; 522/timeout is not.
      const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      const body = await response.text();
      const elapsed_ms = Date.now() - started;

      return json({
        ok: true,
        network_reachable: true,
        megafon_http_status: response.status,
        megafon_status_text: response.statusText,
        elapsed_ms,
        content_type: response.headers.get("content-type"),
        response_body_excerpt: body.slice(0, 500),
      });
    } catch (error) {
      return json({
        ok: false,
        network_reachable: false,
        error_name: error?.name || "Error",
        error_message: error?.message || String(error),
        elapsed_ms: Date.now() - started,
      }, 502);
    }
  },
};
