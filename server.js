const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;
const DATA_DIR = process.env.CRM_DATA_DIR || path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "crm-state.json");
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v20.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PUBLIC_APP_URL = String(process.env.CRM_PUBLIC_URL || "").trim().replace(/\/+$/, "");
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_COOKIE = "ditaranto_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const sessions = new Map();

loadEnvFile();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const session = getSession(req);

    if (req.method === "POST" && url.pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      handleLogout(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      sendJson(res, session ? 200 : 401, { ok: Boolean(session), user: session?.user || "" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      sendJson(res, 200, { ok: true, app: "ditaranto-crm", state: stateSummary(), recoveryAllowed: recoveryLoginAllowed() });
      return;
    }

    if (req.method === "GET" && req.url === "/api/state") {
      if (!session) {
        sendJson(res, 401, { ok: false, error: "Sesión requerida." });
        return;
      }
      handleGetState(res);
      return;
    }

    if (req.method === "GET" && req.url === "/api/health") {
      handleHealth(req, res);
      return;
    }


    if (req.method === "POST" && req.url === "/api/state") {
      await handleSaveState(req, res, session);
      return;
    }

    if (req.method === "POST" && (req.url === "/api/send-receipt-whatsapp" || req.url === "/api/send-document-whatsapp")) {
      if (!session) {
        sendJson(res, 401, { ok: false, error: "Sesión requerida." });
        return;
      }
      await handleSendDocument(req, res);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && ["/celular", "/mobile"].includes(req.url)) {
      serveMobileHelp(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: "Método no permitido." });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || "Error interno." });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`El puerto ${PORT} ya está en uso. Si el CRM ya está abierto, entrá a http://${HOST}:${PORT}.`);
    console.error("Si querés usar otro puerto: PORT=5174 node server.js");
    process.exit(1);
  }

  if (error.code === "EACCES" || error.code === "EPERM") {
    console.error(`No tengo permiso para abrir http://${HOST}:${PORT}. Probá con otro puerto: PORT=5174 node server.js`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const lanIps = localNetworkIps();
  const localName = localHostName();
  console.log(`CRM Detailing en http://127.0.0.1:${PORT}`);
  if (localName) console.log(`CRM Detailing celular: http://${localName}.local:${PORT}/celular`);
  lanIps.forEach((ip) => console.log(`CRM Detailing celular: http://${ip}:${PORT}/celular`));
});

function localNetworkIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

function localHostName() {
  return os.hostname().split(".")[0] || "";
}

function stateSummary() {
  if (!fs.existsSync(STATE_FILE)) {
    return { exists: false, updatedAt: "", clients: 0, appointments: 0, payments: 0, quotes: 0, invoices: 0, loginUser: "" };
  }

  try {
    const payload = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const savedState = payload.state || {};
    return {
      exists: true,
      updatedAt: payload.updatedAt || savedState._updatedAt || "",
      clients: Array.isArray(savedState.clients) ? savedState.clients.length : 0,
      appointments: Array.isArray(savedState.appointments) ? savedState.appointments.length : 0,
      payments: Array.isArray(savedState.payments) ? savedState.payments.length : 0,
      quotes: Array.isArray(savedState.quotes) ? savedState.quotes.length : 0,
      invoices: Array.isArray(savedState.invoices) ? savedState.invoices.length : 0,
      loginUser: savedState.settings?.loginUserSetting || "admin",
    };
  } catch {
    return { exists: false, updatedAt: "", clients: 0, appointments: 0, payments: 0, quotes: 0, invoices: 0, loginUser: "" };
  }
}

function readStatePayload() {
  if (!fs.existsSync(STATE_FILE)) return { updatedAt: "", state: null };
  try {
    const payload = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { updatedAt: payload.updatedAt || "", state: payload.state || null };
  } catch {
    return { updatedAt: "", state: null };
  }
}

function hasBusinessData(savedState = {}) {
  return ["clients", "appointments", "payments", "quotes", "invoices"].some((key) => Array.isArray(savedState[key]) && savedState[key].length > 0);
}

function expectedCredentials() {
  const payload = readStatePayload();
  const settings = payload.state?.settings || {};
  return {
    user: String(process.env.CRM_ADMIN_USER || settings.loginUserSetting || "admin").trim().toLowerCase(),
    password: String(process.env.CRM_ADMIN_PASSWORD || settings.loginPasswordSetting || "1234").trim(),
  };
}

function credentialsMatch(user, password) {
  const expected = expectedCredentials();
  const cleanUser = String(user || "").trim().toLowerCase();
  const cleanPassword = String(password || "").trim();
  const matchesConfiguredLogin = cleanUser === expected.user && cleanPassword === expected.password;
  return matchesConfiguredLogin || (recoveryLoginAllowed() && cleanUser === "admin" && cleanPassword === "1234");
}

function recoveryLoginAllowed() {
  return process.env.ALLOW_RECOVERY_LOGIN === "true" || (!process.env.CRM_ADMIN_PASSWORD && process.env.NODE_ENV !== "production");
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf("=");
      if (index === -1) return acc;
      acc[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
      return acc;
    }, {});
}

function sessionCookie(id, maxAge = SESSION_TTL_MS / 1000) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAge)}${secure}`;
}

function getSession(req) {
  const id = parseCookies(req)[SESSION_COOKIE];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  if (!credentialsMatch(body.user, body.password)) {
    sendJson(res, 401, { ok: false, error: "Usuario o contraseña incorrectos." });
    return;
  }

  const id = crypto.randomBytes(32).toString("hex");
  const user = String(body.user || "").trim().toLowerCase() || "admin";
  sessions.set(id, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  const payload = readStatePayload();
  sendJson(res, 200, { ok: true, user, state: payload.state || null, updatedAt: payload.updatedAt || "" }, { "Set-Cookie": sessionCookie(id) });
}

function handleLogout(req, res) {
  const id = parseCookies(req)[SESSION_COOKIE];
  if (id) sessions.delete(id);
  sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
}

function handleHealth(req, res) {
  const lanIps = localNetworkIps();
  const localName = localHostName();
  const appUrl = publicAppUrl(req);
  sendJson(res, 200, {
    ok: true,
    host: req.headers.host || "",
    onlineUrl: appUrl,
    onlineMode: isCloudRequest(req),
    macUrl: `http://127.0.0.1:${PORT}`,
    mobileUrls: [
      appUrl,
      localName ? `http://${localName}.local:${PORT}/celular` : "",
      ...lanIps.map((ip) => `http://${ip}:${PORT}/celular`),
    ].filter(Boolean).filter((url, index, list) => list.indexOf(url) === index),
    recoveryAllowed: recoveryLoginAllowed(),
    state: stateSummary(),
  });
}

function serveMobileHelp(req, res) {
  const lanIps = localNetworkIps();
  const localName = localHostName();
  const summary = stateSummary();
  const appUrl = publicAppUrl(req);
  const isCloudHost = isCloudRequest(req);
  const urls = isCloudHost
    ? [appUrl]
    : [
        PUBLIC_APP_URL,
        localName ? `http://${localName}.local:${PORT}/celular` : "",
        ...lanIps.map((ip) => `http://${ip}:${PORT}/celular`),
      ].filter(Boolean).filter((url, index, list) => list.indexOf(url) === index);
  const modeTitle = isCloudHost ? "Estás usando la versión online" : "Estás usando la versión desde la Mac";
  const modeText = isCloudHost
    ? "Esta dirección funciona aunque la Mac esté apagada, siempre que el servicio online esté activo."
    : "Esta dirección depende de que la Mac esté prendida. Para usarlo sin la Mac, abrí la URL online de Render.";
  const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ditaranto CRM Celular</title>
    <style>
      body{margin:0;font-family:Arial,sans-serif;background:#070a0b;color:#eef3f0;padding:18px}
      main{max-width:760px;margin:auto;display:grid;gap:14px}
      section{border:1px solid #243036;border-radius:10px;padding:18px;background:#101518}
      h1{margin:0 0 8px;font-size:28px} h2{margin:0 0 10px;font-size:18px}
      p{color:#b8c3bf;line-height:1.45} a{color:#55f02f;font-weight:900;text-decoration:none}
      .url{display:block;border:1px solid #315038;border-radius:8px;margin-top:8px;padding:14px;background:#071007;color:#55f02f;font-size:18px;font-weight:900;word-break:break-all}
      .primary{display:block;border-radius:8px;padding:15px;background:#55f02f;color:#061006;text-align:center;font-size:18px;font-weight:950}
      .ok{color:#55f02f}.bad{color:#ff6b6b} li{margin:8px 0;color:#cbd5d0}
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Ditaranto CRM para celular</h1>
        <p>${modeTitle}. ${modeText}</p>
        <a class="primary" href="${appUrl}">Abrir CRM</a>
      </section>
      <section>
        <h2>Direcciones para probar</h2>
        ${urls.map((url) => `<a class="url" href="${url}">${url}</a>`).join("") || "<p class=\"bad\">No detecté una IP de red en la Mac.</p>"}
      </section>
      <section>
        <h2>Datos compartidos</h2>
        <p class="${summary.exists ? "ok" : "bad"}">${summary.exists ? "La Mac tiene datos compartidos disponibles." : "Todavía no hay datos compartidos guardados en la Mac."}</p>
        <ul>
          <li>Usuario esperado: <strong>${escapeHtml(summary.loginUser || "admin")}</strong></li>
          <li>Clientes: <strong>${summary.clients}</strong></li>
          <li>Turnos: <strong>${summary.appointments}</strong></li>
          <li>Cobros: <strong>${summary.payments}</strong></li>
        </ul>
      </section>
      <section>
        <h2>Reglas para que abra</h2>
        <ol>
          <li>Para usarlo con la Mac apagada, entrá siempre con la URL online de Render.</li>
          <li>No uses 127.0.0.1 desde el celular: esa dirección apunta al propio iPhone.</li>
          <li>Si usás una dirección con números tipo 192.168..., depende de que la Mac esté prendida.</li>
          <li>Entrá primero desde Safari/Chrome y después agregalo a pantalla de inicio.</li>
        </ol>
      </section>
    </main>
  </body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(html);
}

function publicAppUrl(req) {
  if (PUBLIC_APP_URL) return `${PUBLIC_APP_URL}/`;
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0] || (host.includes("onrender.com") ? "https" : "http");
  return `${protocol}://${host}/`;
}

function isCloudRequest(req) {
  const host = req.headers.host || "";
  const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0];
  return Boolean(PUBLIC_APP_URL) || /onrender\.com$/i.test(host) || protocol === "https";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) return;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(requestedPath)));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const headers = {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
    };
    if ([".html", ".js", ".css"].includes(path.extname(filePath)) || path.basename(filePath) === "service-worker.js") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
      headers.Pragma = "no-cache";
      headers.Expires = "0";
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(data);
  });
}

function handleGetState(res) {
  const payload = readStatePayload();
  if (!payload.state) {
    sendJson(res, 200, { ok: true, state: null, updatedAt: "" });
    return;
  }
  sendJson(res, 200, { ok: true, state: payload.state, updatedAt: payload.updatedAt || "" });
}

async function handleSaveState(req, res, session) {
  if (!session) {
    sendJson(res, 401, { ok: false, error: "Sesión requerida." });
    return;
  }

  const body = await readJsonBody(req);
  const incomingState = body.state;
  if (!incomingState || typeof incomingState !== "object" || Array.isArray(incomingState)) {
    sendJson(res, 400, { ok: false, error: "Estado inválido." });
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const updatedAt = new Date().toISOString();
  incomingState._updatedAt = updatedAt;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt, state: incomingState }, null, 2));
  sendJson(res, 200, { ok: true, updatedAt });
}

async function handleSendDocument(req, res) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    sendJson(res, 501, {
      ok: false,
      error: "WhatsApp API no está configurado. Completá WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID en .env.",
    });
    return;
  }

  const body = await readJsonBody(req);
  const to = String(body.to || "").replace(/\D/g, "");
  const filename = safeFileName(body.filename || "documento.pdf");
  const caption = String(body.caption || "Documento adjunto.");
  const pdfBase64 = String(body.pdfBase64 || "");

  if (!to || !pdfBase64) {
    sendJson(res, 400, { ok: false, error: "Faltan datos: to y pdfBase64 son obligatorios." });
    return;
  }

  const pdfBytes = Buffer.from(pdfBase64, "base64");
  const mediaId = await uploadMedia({ accessToken, phoneNumberId, pdfBytes, filename });
  const message = await sendDocumentMessage({ accessToken, phoneNumberId, to, mediaId, filename, caption });

  sendJson(res, 200, { ok: true, mediaId, message });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("El PDF es demasiado grande para enviar desde este servidor local."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
    req.on("error", reject);
  });
}

async function uploadMedia({ accessToken, phoneNumberId, pdfBytes, filename }) {
  const formData = new FormData();
  formData.set("messaging_product", "whatsapp");
  formData.set("type", "application/pdf");
  formData.set("file", new Blob([pdfBytes], { type: "application/pdf" }), filename);

  const response = await fetch(`${GRAPH_URL}/${phoneNumberId}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "No se pudo subir el PDF a WhatsApp.");
  return data.id;
}

async function sendDocumentMessage({ accessToken, phoneNumberId, to, mediaId, filename, caption }) {
  const response = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: {
        id: mediaId,
        filename,
        caption,
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "No se pudo enviar el recibo por WhatsApp.");
  return data;
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(data));
}

function safeFileName(fileName) {
  return String(fileName).replace(/[^\w.-]+/g, "_").slice(0, 80) || "recibo.pdf";
}
