const API_URL = "https://vats123691.megapbx.ru/crmapi/v1/history/json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") return json({ ok: false, error: "GET only" }, 405);

    const started = Date.now();
    if (!env.MEGAFON_API_KEY) {
      return json({ ok: false, error: "MEGAFON_API_KEY secret is not configured" }, 500);
    }

    const url = new URL(API_URL);
    // Minimal request: ask for one incoming record from the current day.
    url.searchParams.set("period", "today");
    url.searchParams.set("type", "in");
    url.searchParams.set("limit", "1");

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-API-KEY": env.MEGAFON_API_KEY,
          "Accept": "application/json",
        },
      });

      const body = await response.text();
      const elapsed_ms = Date.now() - started;

      // Never expose the API key. Limit returned body to a small diagnostic excerpt.
      return json({
        ok: response.ok,
        http_status: response.status,
        status_text: response.statusText,
        elapsed_ms,
        content_type: response.headers.get("content-type"),
        response_body_excerpt: body.slice(0, 1000),
      }, response.ok ? 200 : 502);
    } catch (error) {
      return json({
        ok: false,
        error_name: error?.name || "Error",
        error_message: error?.message || String(error),
        elapsed_ms: Date.now() - started,
      }, 502);
    }
  },
};
