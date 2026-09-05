const API_URL = "https://vats123691.megapbx.ru/crmapi/v1/history/json";
const IP_URL = "https://api.ipify.org?format=json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function getEgressIp() {
  try {
    const response = await fetch(IP_URL, { method: "GET", headers: { "Accept": "application/json" } });
    if (!response.ok) return { ok: false, http_status: response.status };
    const body = await response.json();
    return { ok: true, ip: body?.ip || null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export default {
  async fetch(request) {
    if (request.method !== "GET") return json({ ok: false, error: "GET only" }, 405);

    const started = Date.now();
    const egress = await getEgressIp();
    const url = new URL(API_URL);
    url.searchParams.set("period", "today");
    url.searchParams.set("type", "in");
    url.searchParams.set("limit", "1");

    try {
      // Deliberately omit X-API-KEY: this test checks network reachability only.
      const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      const body = await response.text();
      return json({
        ok: true,
        network_reachable: true,
        worker_egress_ip: egress.ip || null,
        egress_ip_check: egress.ok,
        megafon_http_status: response.status,
        megafon_status_text: response.statusText,
        elapsed_ms: Date.now() - started,
        content_type: response.headers.get("content-type"),
        response_body_excerpt: body.slice(0, 500),
      });
    } catch (error) {
      return json({
        ok: false,
        network_reachable: false,
        worker_egress_ip: egress.ip || null,
        egress_ip_check: egress.ok,
        error_name: error?.name || "Error",
        error_message: error?.message || String(error),
        elapsed_ms: Date.now() - started,
      }, 502);
    }
  },
};
