import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ELDERGUARD_API_KEY || "dev-local-key";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "ARCANGEL <onboarding@resend.dev>";
const LOG_PATH = path.join(process.cwd(), "alerts-log.jsonl");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, service: "arcangel-alert-backend" });
    }

    if (req.method === "POST" && req.url === "/alerts") {
      if (req.headers["x-elderguard-key"] !== API_KEY) {
        return json(res, 401, { ok: false, error: "invalid_api_key" });
      }

      const body = await readJson(req);
      const alert = normalizeAlert(body);
      appendLog(alert);

      const result = await sendEmail(alert);
      return json(res, 200, { ok: true, provider: result });
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message || "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(`ARCANGEL alert backend listening on http://localhost:${PORT}`);
});

function normalizeAlert(body) {
  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  const recipients = contacts
    .map((contact) => String(contact.email || "").trim())
    .filter((email) => email.includes("@"));

  if (recipients.length === 0) {
    throw new Error("no_recipient_emails");
  }

  return {
    id: cryptoRandomId(),
    receivedAt: new Date().toISOString(),
    reason: String(body.reason || "alerta").slice(0, 120),
    message: String(body.message || "Alerta ARCANGEL").slice(0, 3000),
    location: body.location || null,
    contacts,
    recipients
  };
}

async function sendEmail(alert) {
  if (!RESEND_API_KEY) {
    throw new Error("missing_resend_api_key");
  }

  const mapUrl = alert.location && alert.location.lat && alert.location.lon
    ? `https://maps.google.com/?q=${alert.location.lat},${alert.location.lon}`
    : "Ubicacion no disponible";

  const payload = {
    from: FROM_EMAIL,
    to: alert.recipients,
    subject: `Alerta ARCANGEL: ${alert.reason}`,
    text: [
      alert.message,
      "",
      `Motivo: ${alert.reason}`,
      `Hora: ${alert.receivedAt}`,
      `Ubicacion: ${mapUrl}`,
      "",
      "Este aviso se ha enviado automaticamente desde ARCANGEL."
    ].join("\n")
  };

  return postJson("https://api.resend.com/emails", payload, {
    Authorization: `Bearer ${RESEND_API_KEY}`
  });
}

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      }
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`email_provider_${response.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });

    request.on("error", reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 128000) {
        reject(new Error("payload_too_large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function appendLog(alert) {
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(alert)}\n`, "utf8");
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body));
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();

    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
