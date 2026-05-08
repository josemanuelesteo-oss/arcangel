import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.ELDERGUARD_API_KEY || "dev-local-key";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "ARCANGEL <onboarding@resend.dev>";
const LOG_PATH = path.join(process.cwd(), "alerts-log.jsonl");
const DEVICES_PATH = path.join(process.cwd(), "push-devices.json");
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
const FIREBASE_PRIVATE_KEY = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || "");

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

      const result = { ok: true, skipped: "email_disabled" };
      const push = await sendPushNotifications(alert);
      return json(res, 200, { ok: true, provider: result, push });
    }

    if (req.method === "POST" && req.url === "/devices") {
      if (req.headers["x-elderguard-key"] !== API_KEY) {
        return json(res, 401, { ok: false, error: "invalid_api_key" });
      }

      const body = await readJson(req);
      const device = normalizeDevice(body);
      saveDevice(device);
      return json(res, 200, { ok: true, deviceId: device.deviceId });
    }

    if (req.method === "POST" && req.url === "/pairing/request") {
      if (req.headers["x-elderguard-key"] !== API_KEY) {
        return json(res, 401, { ok: false, error: "invalid_api_key" });
      }
      const body = await readJson(req);
      const result = await requestPairing(body);
      return json(res, 200, { ok: true, result });
    }

    if (req.method === "POST" && req.url === "/pairing/accept") {
      if (req.headers["x-elderguard-key"] !== API_KEY) {
        return json(res, 401, { ok: false, error: "invalid_api_key" });
      }
      const body = await readJson(req);
      const result = await acceptPairing(body);
      return json(res, 200, { ok: true, result });
    }

    if (req.method === "GET" && req.url.startsWith("/seniors")) {
      if (req.headers["x-elderguard-key"] !== API_KEY) {
        return json(res, 401, { ok: false, error: "invalid_api_key" });
      }
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const senior = findSeniorByCode(requestUrl.searchParams.get("code"));
      if (!senior) {
        return json(res, 404, { ok: false, error: "senior_not_found" });
      }
      return json(res, 200, { ok: true, senior });
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
  const protectedPerson = normalizeProtectedPerson(body.protectedPerson);
  const recipients = contacts
    .map((contact) => String(contact.email || "").trim())
    .filter((email) => email.includes("@"));

  return {
    id: cryptoRandomId(),
    receivedAt: new Date().toISOString(),
    reason: String(body.reason || "alerta").slice(0, 120),
    message: String(body.message || "Alerta ARCANGEL").slice(0, 3000),
    familyCode: normalizeFamilyCode(body.familyCode),
    protectedPerson,
    location: body.location || null,
    contacts,
    recipients
  };
}

function normalizeDevice(body) {
  const token = String(body.token || "").trim();
  if (!token) {
    throw new Error("missing_push_token");
  }
  return {
    deviceId: String(body.deviceId || cryptoRandomId()).trim().slice(0, 120),
    token,
    role: String(body.role || "caregiver").trim().slice(0, 40),
    enabled: body.enabled !== false,
    familyCode: normalizeFamilyCode(body.familyCode),
    familyCodes: normalizeFamilyCodes(body.familyCodes, body.familyCode),
    protectedPersonName: String(body.protectedPersonName || "").trim().slice(0, 120),
    protectedPersonPhone: String(body.protectedPersonPhone || "").trim().slice(0, 60),
    caregiverName: String(body.caregiverName || "").trim().slice(0, 120),
    updatedAt: new Date().toISOString()
  };
}

function saveDevice(device) {
  const devices = readDevices().filter((item) => item.deviceId !== device.deviceId && item.token !== device.token);
  devices.push(device);
  fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2), "utf8");
}

function readDevices() {
  try {
    if (!fs.existsSync(DEVICES_PATH)) {
      return [];
    }
    const value = JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeFamilyCode(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase().slice(0, 80);
}

function normalizeFamilyCodes(values, fallback) {
  const source = Array.isArray(values) ? values : [];
  const codes = source.map(normalizeFamilyCode).filter(Boolean);
  const fallbackCode = normalizeFamilyCode(fallback);
  if (fallbackCode && !codes.includes(fallbackCode)) {
    codes.push(fallbackCode);
  }
  return codes;
}

function findSeniorByCode(code) {
  const normalized = normalizeFamilyCode(code);
  if (!normalized) {
    return null;
  }
  const senior = readDevices()
    .filter((device) => device.role === "senior")
    .filter((device) => device.familyCode === normalized || (Array.isArray(device.familyCodes) && device.familyCodes.includes(normalized)))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
  if (!senior) {
    return null;
  }
  return {
    code: normalized,
    name: senior.protectedPersonName || "Persona mayor",
    phone: senior.protectedPersonPhone || ""
  };
}

async function requestPairing(body) {
  const seniorCode = normalizeFamilyCode(body.seniorCode);
  const caregiverDeviceId = String(body.caregiverDeviceId || "").trim();
  const caregiverName = String(body.caregiverName || "").trim().slice(0, 120);
  if (!seniorCode || !caregiverDeviceId || !caregiverName) {
    throw new Error("missing_pairing_fields");
  }
  const seniorDevice = readDevices()
    .filter((device) => device.role === "senior")
    .filter((device) => device.familyCode === seniorCode)
    .filter((device) => Boolean(device.token))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
  if (!seniorDevice) {
    throw new Error("senior_not_registered");
  }
  const token = await firebaseAccessToken();
  await sendFcmDataMessage(token, seniorDevice.token, {
    type: "pairing_request",
    caregiverName,
    caregiverDeviceId,
    seniorCode,
    title: "Solicitud de cuidador",
    body: `${caregiverName} quiere añadirte a su lista de personas mayores. ¿Aceptas?`
  });
  return { sent: true };
}

async function acceptPairing(body) {
  const seniorCode = normalizeFamilyCode(body.seniorCode);
  const caregiverDeviceId = String(body.caregiverDeviceId || "").trim();
  const caregiverName = String(body.caregiverName || "").trim().slice(0, 120);
  const seniorName = String(body.seniorName || "Persona mayor").trim().slice(0, 120);
  const seniorPhone = String(body.seniorPhone || "").trim().slice(0, 60);
  const devices = readDevices();
  const caregiver = devices.find((device) => device.deviceId === caregiverDeviceId && device.role === "caregiver");
  if (!caregiver) {
    throw new Error("caregiver_not_registered");
  }
  caregiver.familyCodes = normalizeFamilyCodes(caregiver.familyCodes, caregiver.familyCode);
  if (!caregiver.familyCodes.includes(seniorCode)) {
    caregiver.familyCodes.push(seniorCode);
  }
  caregiver.updatedAt = new Date().toISOString();
  fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2), "utf8");
  const token = await firebaseAccessToken();
  await sendFcmDataMessage(token, caregiver.token, {
    type: "pairing_accepted",
    seniorCode,
    seniorName,
    seniorPhone,
    caregiverName,
    title: "Solicitud aceptada",
    body: `${seniorName} ya aparece en tu lista de Mayores.`
  });
  return { accepted: true };
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
    subject: emailSubject(alert),
    text: [
      `Persona protegida: ${alert.protectedPerson.name}`,
      alert.protectedPerson.phone ? `Telefono: ${alert.protectedPerson.phone}` : "",
      "",
      alert.message,
      "",
      `Motivo: ${alert.reason}`,
      `Hora: ${alert.receivedAt}`,
      `Ubicacion: ${mapUrl}`,
      "",
      "Este aviso se ha enviado automaticamente desde ARCANGEL."
    ].filter(Boolean).join("\n")
  };

  const response = await postJson("https://api.resend.com/emails", payload, {
    Authorization: `Bearer ${RESEND_API_KEY}`
  });

  return response;
}

async function sendPushNotifications(alert) {
  const devices = readDevices()
    .filter((device) => device.enabled !== false)
    .filter((device) => device.role === "caregiver")
    .filter((device) => Array.isArray(device.familyCodes)
      ? device.familyCodes.includes(alert.familyCode)
      : device.familyCode && device.familyCode === alert.familyCode)
    .filter((device) => Boolean(device.token));

  if (devices.length === 0) {
    return { ok: true, sent: 0, skipped: "no_paired_caregivers" };
  }
  if (!firebaseConfigured()) {
    return { ok: false, sent: 0, skipped: "firebase_not_configured" };
  }

  const token = await firebaseAccessToken();
  let sent = 0;
  const errors = [];
  for (const device of devices) {
    try {
      await sendFcmMessage(token, device.token, alert);
      sent += 1;
    } catch (error) {
      errors.push(error.message || "push_error");
    }
  }
  return { ok: errors.length === 0, sent, errors: errors.slice(0, 3) };
}

function firebaseConfigured() {
  const account = firebaseAccount();
  return Boolean(FIREBASE_PROJECT_ID && account.clientEmail && account.privateKey);
}

function firebaseAccount() {
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
      return {
        clientEmail: parsed.client_email || "",
        privateKey: normalizePrivateKey(parsed.private_key || "")
      };
    } catch {
      return { clientEmail: "", privateKey: "" };
    }
  }
  return {
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY
  };
}

async function firebaseAccessToken() {
  const account = firebaseAccount();
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const assertion = signJwt(claim, account.privateKey);
  const response = await postForm("https://oauth2.googleapis.com/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  if (!response.access_token) {
    throw new Error("firebase_access_token_missing");
  }
  return response.access_token;
}

function signJwt(claim, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaim = base64Url(JSON.stringify(claim));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedClaim}`);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${encodedHeader}.${encodedClaim}.${base64Url(signature)}`;
}

async function sendFcmMessage(accessToken, deviceToken, alert) {
  const locationText = alert.location && alert.location.lat && alert.location.lon
    ? `Ubicacion: https://maps.google.com/?q=${alert.location.lat},${alert.location.lon}`
    : "Ubicacion no disponible";
  const body = `${alert.protectedPerson.name}: ${alert.reason}. ${locationText}`;
  const hasLocation = Boolean(alert.location && alert.location.lat && alert.location.lon);
  const payload = {
    message: {
      token: deviceToken,
      data: {
        title: `Alerta ARCANGEL: ${alert.protectedPerson.name}`,
        body,
        reason: alert.reason,
        protectedPerson: alert.protectedPerson.name,
        alertId: String(alert.id),
        lat: hasLocation ? String(alert.location.lat) : "",
        lon: hasLocation ? String(alert.location.lon) : ""
      },
      android: {
        priority: "HIGH"
      }
    }
  };
  return postJson(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, payload, {
    Authorization: `Bearer ${accessToken}`
  });
}

function sendFcmDataMessage(accessToken, deviceToken, data) {
  const normalized = {};
  for (const [key, value] of Object.entries(data)) {
    normalized[key] = value == null ? "" : String(value);
  }
  const payload = {
    message: {
      token: deviceToken,
      data: normalized,
      android: {
        priority: "HIGH"
      }
    }
  };
  return postJson(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, payload, {
    Authorization: `Bearer ${accessToken}`
  });
}

function normalizeProtectedPerson(value) {
  const source = value && typeof value === "object" ? value : {};
  const name = String(source.name || "").trim().slice(0, 120);
  const phone = String(source.phone || "").trim().slice(0, 60);
  return {
    name: name || "Persona protegida",
    phone
  };
}

function emailSubject(alert) {
  return `Alerta ARCANGEL: ${alert.protectedPerson.name} - ${alert.reason}`;
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

function postForm(url, payload) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(payload).toString();
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`oauth_${response.statusCode}: ${data}`));
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
    request.write(body);
    request.end();
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 128_000) {
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
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
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
