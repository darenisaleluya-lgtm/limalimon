function assertConfig() {
  const config = window.APP_CONFIG;
  if (!config || typeof config.API_URL !== "string") throw new Error("Falta js/config.js");
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(config.API_URL)) {
    throw new Error("Configure API_URL con la URL /exec del despliegue de Apps Script");
  }
  return config;
}

function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ApiClient {
  constructor() {
    this.config = assertConfig();
    this.pending = 0;
    this.listeners = new Set();
  }

  onPendingChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPending(delta) {
    this.pending = Math.max(0, this.pending + delta);
    this.listeners.forEach(listener => listener(this.pending));
  }

  async jsonp(params, timeoutMs = this.config.API_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const callback = `__survey_jsonp_${requestId().replace(/-/g, "")}`;
      const script = document.createElement("script");
      const timer = setTimeout(() => cleanup(new Error("Tiempo agotado consultando Apps Script")), timeoutMs);

      const cleanup = error => {
        clearTimeout(timer);
        script.remove();
        try { delete window[callback]; } catch { window[callback] = undefined; }
        if (error) reject(error);
      };

      window[callback] = data => {
        cleanup();
        resolve(data);
      };
      script.onerror = () => cleanup(new Error("No fue posible leer la respuesta de Apps Script"));
      const search = new URLSearchParams({ ...params, callback, _: String(Date.now()) });
      script.src = `${this.config.API_URL}?${search.toString()}`;
      script.async = true;
      document.head.appendChild(script);
    });
  }

  async health() {
    const result = await this.jsonp({ action: "health" }, 12000);
    return Boolean(result && result.ok && result.serviceAvailable !== false);
  }

  async surveyInfo(surveyId) {
    const result = await this.jsonp({ action: "surveyInfo", surveyId }, 12000);
    if (!result || result.ok !== true || !result.survey) throw new Error("No fue posible leer la configuración pública de la encuesta");
    return result.survey;
  }

  async sendEnvelope(envelope) {
    const body = new URLSearchParams({ request: JSON.stringify(envelope) });
    await fetch(this.config.API_URL, {
      method: "POST",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      body
    });
  }

  async pollResult(id) {
    const deadline = Date.now() + this.config.API_TIMEOUT_MS;
    let delay = this.config.POLL_INTERVAL_MS;
    while (Date.now() < deadline) {
      const result = await this.jsonp({ action: "poll", requestId: id }, Math.min(12000, this.config.API_TIMEOUT_MS));
      if (result && result.status === "ready") return result.result;
      if (result && result.status === "expired") throw new Error("La respuesta temporal expiró; reintente");
      await sleep(delay);
      delay = Math.min(2500, Math.round(delay * 1.25));
    }
    throw new Error("Apps Script no confirmó la operación a tiempo");
  }

  async call(action, payload = {}, sessionToken = "", forcedRequestId = "") {
    const id = forcedRequestId || requestId();
    const envelope = {
      version: 1,
      requestId: id,
      action,
      sessionToken,
      clientTime: new Date().toISOString(),
      payload
    };

    this.setPending(1);
    try {
      await this.sendEnvelope(envelope);
      let result;
      try {
        result = await this.pollResult(id);
      } catch (firstError) {
        // Repetir la misma solicitud es seguro: el servidor usa requestId e idempotencia.
        await this.sendEnvelope(envelope);
        result = await this.pollResult(id);
      }
      if (!result || result.ok !== true) {
        const error = new Error(result?.error?.message || "La operación fue rechazada");
        error.code = result?.error?.code || "API_ERROR";
        throw error;
      }
      return { requestId: id, ...result.data };
    } finally {
      this.setPending(-1);
    }
  }
}
