import React, { useRef, useState, useEffect, useMemo } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { v4 as uuidv4 } from "uuid";
import { oauth2 as SMART } from "fhirclient";

/**
 * FHIR Medical Device Management System with Modal Scanner
 * - Equipment: Main form with modal scanner for barcode identification
 * - Save: Submit as transaction Bundle with Device + DeviceUseStatement (R4)
 * - Stock: Query usage records with sorting support; view details; delete records
 * - Used List: Query completed usage records; details
 */

// Sunjia Zhang====== Configuration ======
const FHIR_BASE: string = "https://hapi.fhir.org/baseR4";
const APP_TAG_SYSTEM = "urn:demo:app";
const APP_TAG_CODE = "demo-medical-stock";
const APP_TAG_DISPLAY = "Medical Device Stock";

// Together====== SMART-on-FHIR ======
// TODO: Replace with your real Client ID from SMART sandbox/EHR registration
const SMART_CLIENT_ID = "fhir-scan-stock"; // <- set this
const SMART_SCOPE = "launch/patient patient/*.read patient/*.write openid fhirUser";
const SMART_REDIRECT_URI = window.location.origin + window.location.pathname; // SPA redirect back to same path

let SMART_CLIENT: any = null;
let SMART_SERVER_URL: string | null = null;
let SMART_PATIENT_ID: string | null = null;

function getQueryParam(name: string): string | null {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

async function tryInitSmartFromRedirect() {
  try {
    const client = await SMART.ready();
    SMART_CLIENT = client;
    // serverUrl may be in client.state.serverUrl; keep defensive access
    SMART_SERVER_URL = (client as any)?.state?.serverUrl || (client as any)?.server?.serviceUrl || null;
    try {
      SMART_PATIENT_ID = await client.getPatientId();
    } catch {
      SMART_PATIENT_ID = null;
    }
    console.log("SMART ready:", { SMART_SERVER_URL, SMART_PATIENT_ID });
  } catch (e) {
    // Not a SMART redirect context; ignore silently
  }
}

async function smartAuthorizeFlow() {
  const issParam = getQueryParam("iss") || window.prompt("FHIR base URL (iss) for SMART authorization:", SMART_SERVER_URL || "");
  if (!issParam) return;
  await SMART.authorize({
    clientId: SMART_CLIENT_ID,
    scope: SMART_SCOPE,
    redirectUri: SMART_REDIRECT_URI,
    iss: issParam,
  });
}

// Tian Zhao====== Medical Device Barcode Database ======
const BARCODE_DATABASE: Record<string, {
  Category: string;
  Products: string;
  Supplier: string;
  StockLevel: number;
}> = {
  "1000000000001": { Category: "Guide Catheter", Products: "6FR JR4.0", Supplier: "Medtronic", StockLevel: 50 },
  "1000000000002": { Category: "Diagnostic Catheter", Products: "5FR TIG", Supplier: "Terumo", StockLevel: 100 },
  "1000000000003": { Category: "Guide Wire", Products: "260J 0.35", Supplier: "Merit", StockLevel: 100 },
  "1000000000004": { Category: "Interventional Wire", Products: "Sion Blue", Supplier: "Asahi", StockLevel: 100 },
  "0101234567890": { Category: "Stent", Products: "3.5mm*30mm", Supplier: "Medtronic Onyx Frontier", StockLevel: 5 },
  "1000000000006": { Category: "Balloon NC", Products: "3.5mm*10mm", Supplier: "Boston Scientific NC Emerge", StockLevel: 9 },
  "1000000000007": { Category: "Balloon Semi", Products: "3.0mm*15mm", Supplier: "Boston Scientific Emerge", StockLevel: 12 },
};

// Sunjia Zhang====== FHIR helpers ======
export async function fhirTransaction(bundle: any) {
  // Prefer SMART client when available
  if (SMART_CLIENT) {
    const headers = { "Content-Type": "application/fhir+json" } as Record<string, string>;
    try {
      // Try a proper FHIR transaction first (POST to [base])
      const res = await SMART_CLIENT.request("/", {
        method: "POST",
        headers,
        body: JSON.stringify(bundle),
      });
      return res;
    } catch (err: any) {
      console.warn("Transaction POST to [base] failed; falling back to stepped create:", err);

      // Minimal fallback that supports our use case: Device + DeviceUseStatement
      const entries = Array.isArray(bundle?.entry) ? bundle.entry : [];
      const deviceEntry = entries.find((e: any) => e?.resource?.resourceType === "Device") || null;
      const dusEntry = entries.find((e: any) => e?.resource?.resourceType === "DeviceUseStatement") || null;

      let createdDevice: any = null;

      if (deviceEntry) {
        createdDevice = await SMART_CLIENT.request("Device", {
          method: "POST",
          headers,
          body: JSON.stringify(deviceEntry.resource),
        });
      }

      if (dusEntry) {
        const dusRes = { ...(dusEntry.resource || {}) };
        // If DUS.device.reference was urn:uuid:..., rewrite it to the newly created Device/<id>
        const ref = dusRes?.device?.reference;
        if (ref && typeof ref === "string" && ref.startsWith("urn:uuid:") && createdDevice?.id) {
          dusRes.device = { reference: `Device/${createdDevice.id}` };
        }
        const createdDus = await SMART_CLIENT.request("DeviceUseStatement", {
          method: "POST",
          headers,
          body: JSON.stringify(dusRes),
        });
        return { resourceType: "Bundle", type: "batch-response", entry: [
          createdDevice ? { resource: createdDevice } : null,
          { resource: createdDus },
        ].filter(Boolean) };
      }

      // If there was no DUS, just return the created device
      if (createdDevice) return createdDevice;

      // If nothing was posted, rethrow original error
      throw err;
    }
  }

  // Anonymous (non-SMART) path – use baseR4 as before
  const res = await fetch(`${FHIR_BASE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/fhir+json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) throw new Error(`FHIR transaction failed: ${res.status} - ${await res.text()}`);
  return res.json();
}

export async function fhirSearch(pathAndQuery: string) {
  const separator = pathAndQuery.includes('?') ? '&' : '?';
  const withTs = `${pathAndQuery}${separator}_ts=${Date.now()}`;
  if (SMART_CLIENT) {
    return SMART_CLIENT.request(withTs);
  }
  const res = await fetch(`${FHIR_BASE}/${withTs}`, {
    headers: { 
      Accept: "application/fhir+json",
      "Cache-Control": "no-cache"
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FHIR search failed: ${res.status}${body ? " - " + body : ""}`);
  }
  return res.json();
}

export async function fhirRead(ref: string) {
  const normalized = ref.replace(/^\/+/, "");
  if (SMART_CLIENT) {
    return SMART_CLIENT.request(normalized);
  }
  const res = await fetch(`${FHIR_BASE}/${normalized}`, { headers: { Accept: "application/fhir+json" } });
  if (!res.ok) throw new Error(`FHIR read failed: ${res.status} - ${await res.text()}`);
  return res.json();
}

export async function fhirDelete(path: string) {
  const separator = path.includes('?') ? '&' : '?';
  const fullPath = `${path.replace(/^\/+/, "")}${separator}_cascade=delete`;
  if (SMART_CLIENT) {
    // Note: _cascade is server-specific; consider manual cascading in production
    await SMART_CLIENT.request(fullPath, { method: "DELETE" });
    return;
  }
  const res = await fetch(`${FHIR_BASE}/${fullPath}`, { 
    method: "DELETE",
    headers: { "Cache-Control": "no-cache" }
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`FHIR delete failed: ${res.status}${body ? " - " + body : ""}`);
  }
}

export async function fhirUpdate(path: string, resource: any) {
  const normalized = path.replace(/^\/+/, "");
  if (SMART_CLIENT) {
    return SMART_CLIENT.request(normalized, { method: "PUT", body: JSON.stringify(resource), headers: { "Content-Type": "application/fhir+json" } });
  }
  const res = await fetch(`${FHIR_BASE}/${normalized}`, {
    method: "PUT",
    headers: { "Content-Type": "application/fhir+json" },
    body: JSON.stringify(resource),
  });
  if (!res.ok) throw new Error(`FHIR update failed: ${res.status} - ${await res.text()}`);
  return res.json();
}

export function idFromLocation(loc?: string) {
  if (!loc) return null;
  const m = loc.match(/^[A-Za-z]+\/([^/]+)/);
  return m ? m[1] : null;
}

export function bundleEntries(bundle: any): any[] {
  return Array.isArray(bundle?.entry) ? bundle.entry.map((e: any) => e.resource) : [];
}

// Tian Zhao====== Barcode Recognition Function ======
export function identifyBarcode(barcode: string): { 
  Category: string; 
  Products: string; 
  Supplier: string; 
  StockLevel: number; 
} {
  // 1) DB match
  if (BARCODE_DATABASE[barcode]) return BARCODE_DATABASE[barcode];

  // 2) JSON QR
  try {
    const parsed = JSON.parse(barcode);
    if (parsed.Products || parsed.name) {
      return {
        Category: parsed.Category || "Uncategorized",
        Products: parsed.Products || parsed.name || barcode,
        Supplier: parsed.Supplier || "Unknown Supplier",
        StockLevel: parsed.StockLevel || 0,
      };
    }
  } catch {}

  // 3) Pattern hints
  if (barcode.length === 13 && barcode.startsWith("100")) {
    return { Category: "Medical Device", Products: barcode, Supplier: "Unknown", StockLevel: 0 };
  }
  if (barcode.length === 13 && barcode.startsWith("010")) {
    return { Category: "Implantable Device", Products: barcode, Supplier: "Unknown", StockLevel: 0 };
  }

  // 4) Default fallback
  return { Category: "Uncategorized", Products: barcode, Supplier: "Unknown", StockLevel: 0 };
}

// Testing helpers (no runtime use)
export function __setSmartClientForTest(client: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (SMART_CLIENT as any) = client;
}
export function __clearSmartClientForTest() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (SMART_CLIENT as any) = null;
}

// Sunjia Zhang====== ECG Background ======
function ECGBackground() {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-gray-950 text-white">
      <svg className="w-full h-full opacity-70" viewBox="0 0 1600 900" preserveAspectRatio="none">
        <defs>
          <linearGradient id="pulse" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopOpacity="1" stopColor="#00ff99" />
            <stop offset="100%" stopOpacity="1" stopColor="#00d4ff" />
          </linearGradient>
        </defs>
        <g stroke="#0a0a0a">
          {Array.from({ length: 60 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 28} y1={0} x2={i * 28} y2={900} strokeWidth="1" />
          ))}
          {Array.from({ length: 30 }).map((_, i) => (
            <line key={`h${i}`} x1={0} y1={i * 30} x2={1600} y2={i * 30} strokeWidth="1" />
          ))}
        </g>
        <path
          d="M0 450 L100 450 L150 430 L200 470 L250 450 L350 450 L390 420 L420 480 L450 440 L600 450 L700 450 L740 415 L770 485 L810 445 L980 450 L1000 450 L1050 425 L1090 485 L1140 445 L1300 450 L1600 450"
          stroke="url(#pulse)"
          strokeWidth="3"
          fill="none"
        >
          <animate
            attributeName="d"
            dur="3s"
            repeatCount="indefinite"
            values="
              M0 450 L100 450 L150 430 L200 470 L250 450 L350 450 L390 420 L420 480 L450 440 L600 450 L700 450 L740 415 L770 485 L810 445 L980 450 L1000 450 L1050 425 L1090 485 L1140 445 L1300 450 L1600 450;
              M0 450 L100 450 L150 430 L200 470 L250 450 L350 450 L390 440 L420 460 L450 450 L600 450 L700 450 L740 425 L770 475 L810 455 L980 450 L1000 450 L1050 435 L1090 475 L1140 455 L1300 450 L1600 450;
              M0 450 L100 450 L150 430 L200 470 L250 450 L350 450 L390 420 L420 480 L450 440 L600 450 L700 450 L740 415 L770 485 L810 445 L980 450 L1000 450 L1050 425 L1090 485 L1140 445 L1300 450 L1600 450
            "
          />
        </path>
      </svg>
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/60" />
    </div>
  );
}

// Sunjia Zhang====== Top Navigation Bar ======
function TopNav({
  onHome,
  onEquipment,
  onUsedList,
  onStock,
}: {
  onHome: () => void;
  onEquipment: () => void;
  onUsedList: () => void;
  onStock: () => void;
}) {
  return (
    <div className="fixed top-0 left-0 right-0 z-[80] flex items-center justify-between bg-black/70 backdrop-blur border-b border-white/10 px-4 py-2">
      <div onClick={onHome} className="text-white font-bold cursor-pointer hover:text-emerald-300">
        🏥 Device Manager
      </div>
      <div className="flex gap-4 text-sm">
        <button onClick={onEquipment} className="text-white/80 hover:text-white">📱 Equipment</button>
        <button onClick={onStock} className="text-white/80 hover:text-white">📦 Stock</button>
        <button onClick={onUsedList} className="text-white/80 hover:text-white">📋 Used</button>
        <button onClick={smartAuthorizeFlow} className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white">
          🔐 Connect
        </button>
      </div>
    </div>
  );
}

// Sunjia Zhang====== Bottom Navigation Buttons ======
function BottomNav({ onEquipment, onStock, onUsedList }: { onEquipment: () => void; onStock: () => void; onUsedList: () => void }) {
  return (
    <div className="fixed bottom-4 left-0 right-0 flex items-center justify-center gap-3">
      <button
        onClick={onEquipment}
        className="px-4 py-2 rounded-2xl bg-emerald-500/90 hover:bg-emerald-400 text-white font-semibold shadow-lg backdrop-blur text-sm"
      >
        📱 Registration
      </button>
      <button
        onClick={onUsedList}
        className="px-4 py-2 rounded-2xl bg-orange-500/90 hover:bg-orange-400 text-white font-semibold shadow-lg backdrop-blur text-sm"
      >
        📋 Used List
      </button>
      <button
        onClick={onStock}
        className="px-4 py-2 rounded-2xl bg-cyan-500/90 hover:bg-cyan-400 text-white font-semibold shadow-lg backdrop-blur text-sm"
      >
        📦 Stock
      </button>
    </div>
  );
}

// Tian Zhao====== Scanner Modal Component ======
function ScannerModal({
  isOpen,
  onClose,
  onScanResult
}: {
  isOpen: boolean;
  onClose: () => void;
  onScanResult: (barcode: string, deviceInfo: any) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const [scanResult, setScanResult] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isScanning, setIsScanning] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      startScanner();
    } else {
      stopScanner();
      setScanResult("");
      setError("");
    }
    return () => stopScanner();
  }, [isOpen]);

  const startScanner = async () => {
    try {
      setError("");
      setIsScanning(true);

      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;

      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      if (devices.length === 0) {
        throw new Error("No camera device found");
      }

      const deviceId = devices[0]?.deviceId;

      await reader.decodeFromVideoDevice(
        deviceId ?? undefined,
        videoRef.current!,
        async (result, err, controls) => {
          if (!result) return;

          const text = result.getText();
          setScanResult(text);

          const identified = identifyBarcode(text);
          if (identified) {
            controls?.stop();
            setIsScanning(false);

            onScanResult(text, identified);

            setTimeout(() => {
              onClose();
            }, 300);
          }
        }
      );
    } catch (e: any) {
      setError(e?.message || String(e));
      setIsScanning(false);
    }
  };

  const stopScanner = () => {
    try {
      readerRef.current?.reset();
    } catch {}
    setIsScanning(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-x-0 top-12 bottom-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-black/90 border border-white/20 rounded-2xl p-6 w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-white">📷 Barcode Scanner</h2>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white text-2xl leading-none"
          >
            ✕
          </button>
        </div>

        <div className="aspect-video w-full overflow-hidden rounded-xl bg-black/50 relative mb-4">
          <video ref={videoRef} className="w-full h-full object-cover" muted autoPlay playsInline />

          {isScanning && (
            <div className="absolute inset-0">
              <div className="absolute top-4 left-4 px-3 py-1 bg-emerald-500/90 rounded-full text-black text-sm font-semibold">
                🔍 Scanning for barcode...
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-64 h-64 border-2 border-emerald-400 rounded-xl relative">
                  <div className="absolute -top-1 -left-1 w-6 h-6 border-l-4 border-t-4 border-emerald-400" />
                  <div className="absolute -top-1 -right-1 w-6 h-6 border-r-4 border-t-4 border-emerald-400" />
                  <div className="absolute -bottom-1 -left-1 w-6 h-6 border-l-4 border-b-4 border-emerald-400" />
                  <div className="absolute -bottom-1 -right-1 w-6 h-6 border-r-4 border-b-4 border-emerald-400" />
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-emerald-400 animate-pulse">
                    <div className="w-full h-full bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-pulse" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {scanResult && (
          <div className="p-4 bg-emerald-900/50 rounded-xl border border-emerald-500/30 mb-4">
            <div className="text-emerald-300 font-semibold mb-2">✅ Barcode Detected!</div>
            <div className="text-emerald-100 break-all font-mono text-sm">{scanResult}</div>
            {identifyBarcode(scanResult) && (
              <div className="text-emerald-400 text-sm mt-2">
                🎯 Device identified! Opening confirmation panel...
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-900/50 rounded-xl border border-red-500/30 mb-4">
            <div className="text-red-300">❌ Scanner Error: {error}</div>
          </div>
        )}

        <div className="flex gap-3">
          {isScanning ? (
            <button onClick={stopScanner} className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white">
              ⏹️ Stop Scanner
            </button>
          ) : (
            <button onClick={startScanner} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white">
              📷 Start Scanner
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-white">
            Cancel
          </button>
        </div>

        <div className="mt-4 text-white/60 text-sm">
          Point your camera at a medical device barcode. The scanner will automatically identify the device and fill the form.
        </div>
      </div>
    </div>
  );
}

// Sunjia Zhang====== Home Page ======
function HomePage() {
  return (
    <div className="min-h-screen text-white flex items-center justify-center">
      <ECGBackground />
      <div className="text-center px-6 pt-16">
        <h1 className="text-4xl md:text-5xl font-extrabold mb-4 tracking-tight">FHIR-based Medical Device Barcode Recognition and Stock Management System</h1>
        <p className="text-white/80 max-w-2xl mx-auto mb-8 text-lg">
         HAPI FHIR Server 
        </p>
        <div className="flex flex-col sm:flex-row gap-6 justify-center items-center mb-8">
          <div className="flex items-center gap-3 text-emerald-300 bg-emerald-900/20 px-4 py-3 rounded-xl border border-emerald-500/30">
            <span className="text-2xl">📱</span>
            <div className="text-left">
              <div className="font-semibold">Equipment Registration</div>
              <div className="text-sm text-emerald-200">Modal barcode scanner + form</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-cyan-300 bg-cyan-900/20 px-4 py-3 rounded-xl border border-cyan-500/30">
            <span className="text-2xl">📦</span>
            <div className="text-left">
              <div className="font-semibold">Stock Management</div>
              <div className="text-sm text-cyan-200">Inventory tracking & alerts</div>
            </div>
          </div>
        </div>

        <div className="max-w-4xl mx-auto mb-8">
          <div className="text-white/60 text-sm mb-4">Simple Workflow:</div>
          <div className="flex flex-col md:flex-row items-center justify-center gap-4">
            <div className="bg-black/30 border border-white/10 rounded-lg p-4 text-sm flex-1 max-w-xs">
              <div className="text-2xl mb-2">📷</div>
              <div className="text-emerald-300 font-semibold">1. Scan Barcode</div>
              <div className="text-white/70">Click scan button to open modal scanner</div>
            </div>
            <div className="text-white/40">→</div>
            <div className="bg-black/30 border border-white/10 rounded-lg p-4 text-sm flex-1 max-w-xs">
              <div className="text-2xl mb-2">🎯</div>
              <div className="text-blue-300 font-semibold">2. Auto-Fill Form</div>
              <div className="text-white/70">Device info automatically populated</div>
            </div>
            <div className="text-white/40">→</div>
            <div className="bg-black/30 border border-white/10 rounded-lg p-4 text-sm flex-1 max-w-xs">
              <div className="text-2xl mb-2">💾</div>
              <div className="text-purple-300 font-semibold">3. Save to FHIR</div>
              <div className="text-white/70">Stored in standardized format</div>
            </div>
          </div>
        </div>

        <div className="mt-8 text-white/60 text-sm">
          <span className="text-yellow-300">Public FHIR Server R4</span>
        </div>
      </div>
    </div>
  );
}

// Tian Zhao====== Scan Review Modal ======
function ScanReviewModal({
  isOpen,
  barcode,
  deviceInfo,
  notes,
  setNotes,
  onCancel,
  onSave,
}: {
  isOpen: boolean;
  barcode: string;
  deviceInfo: { Category: string; Products: string; Supplier: string; StockLevel: number } | null;
  notes: string;
  setNotes: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-x-0 top-12 bottom-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-2xl bg-white text-black rounded-2xl shadow-2xl overflow-hidden mx-4">
        <div className="px-5 py-3 border-b bg-gray-100 font-semibold text-lg">
          Confirm Device Information
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          <div><strong>Barcode:</strong> {barcode}</div>
          <div><strong>Category:</strong> {deviceInfo?.Category}</div>
          <div><strong>Product:</strong> {deviceInfo?.Products}</div>
          <div><strong>Supplier:</strong> {deviceInfo?.Supplier}</div>

          <div className="mt-3">
            <div className="text-gray-600 mb-1">Notes</div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any remarks..."
              rows={4}
              className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex justify-between">
          <button
            onClick={onSave}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
          >
            💾 Save
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// Tian Zhao====== Equipment Form Page ======
/* c8 ignore start – exclude EquipmentPage from coverage */
function EquipmentPage({ onSaved }: { onSaved: (saved: any) => void }) {
  const [error, setError] = useState<string>("");
  const [showScanner, setShowScanner] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<string>("");
  const [category, setCategory] = useState("");
  const [products, setProducts] = useState("");
  const [supplier, setSupplier] = useState("");
  const [stockLevel, setStockLevel] = useState<number>(0);
  const [isAutoFilled, setIsAutoFilled] = useState<boolean>(false);
  const [showReview, setShowReview] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleScanResult = (barcode: string, deviceInfo: any) => {
    setScanResult(barcode);
    setCategory(deviceInfo.Category);
    setProducts(deviceInfo.Products);
    setSupplier(deviceInfo.Supplier);
    setStockLevel(deviceInfo.StockLevel ?? 0);
    setIsAutoFilled(true);
    setShowReview(true);
  };

  const onSave = async () => {
    setError("");
    if (!products.trim() || !category.trim()) {
      setError("Please fill in or scan device product/category information");
      return;
    }
    if (isSubmitting) return;
    setIsSubmitting(true);

    const nowISO = new Date().toISOString();
    const uid = uuidv4();

    const baseNote = `Medical device created at ${nowISO}${isAutoFilled ? " (auto-identified)" : ""}`;
    const mergedNote = reviewNotes ? `${baseNote}\nNotes: ${reviewNotes}` : baseNote;

    const device: any = {
      resourceType: "Device",
      status: "active",
      meta: { tag: [{ system: APP_TAG_SYSTEM, code: APP_TAG_CODE, display: APP_TAG_DISPLAY }] },
      identifier: [
        { system: "urn:demo:inventory", value: uid },
        ...(scanResult ? [{ system: "urn:barcode", value: scanResult }] : []),
      ],
      deviceName: [{ name: products.trim(), type: "user-friendly-name" }],
      type: { text: category },
      manufacturer: supplier || undefined,
      property: [
        ...(category ? [{ type: { text: "category" }, valueString: category }] : []),
        ...(supplier ? [{ type: { text: "supplier" }, valueString: supplier }] : []),
        ...(typeof stockLevel === "number" ? [{ type: { text: "stockLevel" }, valueQuantity: { value: stockLevel } }] : []),
      ],
      extension: [
        ...(category ? [{ url: "urn:demo:category", valueString: category }] : []),
        ...(supplier ? [{ url: "urn:demo:supplier", valueString: supplier }] : []),
        ...(typeof stockLevel === "number" ? [{ url: "urn:demo:stockLevel", valueInteger: stockLevel }] : []),
      ],
      udiCarrier: scanResult ? [{ carrierHRF: scanResult, entryType: "barcode" }] : undefined,
      note: [{ text: mergedNote }],
    };

    let deviceRef: string | null = `urn:uuid:${uid}`;
    let deviceEntry: any | null = { fullUrl: `urn:uuid:${uid}`, resource: device, request: { method: "POST", url: "Device" } };

    const delta = (typeof stockLevel === "number" && !Number.isNaN(stockLevel) ? stockLevel : 1);

    let createUsage = true;

    try {
      const tag = `${encodeURIComponent(APP_TAG_SYSTEM)}|${encodeURIComponent(APP_TAG_CODE)}`;
      const barcodeId = device?.identifier?.find((i: any) => i?.system === "urn:barcode")?.value;

      if (barcodeId) {
        const existingBundle = await fhirSearch(
          `Device?identifier=urn:barcode|${encodeURIComponent(barcodeId)}&_tag=${tag}&_sort=-_lastUpdated&_count=1`
        );
        const existing = bundleEntries(existingBundle)[0];

        if (existing?.id) {
          deviceRef = `Device/${existing.id}`;
          deviceEntry = null;
          createUsage = true;

          let oldStock = 0;
          const ext = existing.extension?.find((e: any) => e?.url === "urn:demo:stockLevel");
          if (ext && typeof ext.valueInteger === "number") oldStock = ext.valueInteger;
          const newStock = Math.max(0, (oldStock || 0) - 1);

          existing.extension = [
            ...(existing.extension || []).filter((e: any) => e.url !== "urn:demo:stockLevel"),
            { url: "urn:demo:stockLevel", valueInteger: newStock },
          ];
          if (Array.isArray(existing.property)) {
            let found = false;
            existing.property = existing.property.map((p: any) => {
              if (p?.type?.text === "stockLevel") {
                found = true;
                return { ...p, valueQuantity: { value: newStock } };
              }
              return p;
            });
            if (!found) {
              existing.property.push({ type: { text: "stockLevel" }, valueQuantity: { value: newStock } });
            }
          } else {
            existing.property = [{ type: { text: "stockLevel" }, valueQuantity: { value: newStock } }];
          }

          await fhirUpdate(`Device/${existing.id}`, existing);
        } else {
          const newStock = Math.max(0, (delta || 0) - 1);
          device.extension = [
            ...(device.extension || []).filter((e: any) => e.url !== "urn:demo:stockLevel"),
            { url: "urn:demo:stockLevel", valueInteger: newStock },
          ];
          device.property = [
            ...(device.property || []).filter((p: any) => p?.type?.text !== "stockLevel"),
            { type: { text: "stockLevel" }, valueQuantity: { value: newStock } },
          ];
        }
      } else {
        const newStock = Math.max(0, (delta || 0) - 1);
        device.extension = [
          ...(device.extension || []).filter((e: any) => e.url !== "urn:demo:stockLevel"),
          { url: "urn:demo:stockLevel", valueInteger: newStock },
        ];
        device.property = [
          ...(device.property || []).filter((p: any) => p?.type?.text !== "stockLevel"),
          { type: { text: "stockLevel" }, valueQuantity: { value: newStock } },
        ];
      }
    } catch (e) {
      console.warn("Device lookup/update failed:", e);
    }

    const tx = {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        ...(deviceEntry ? [deviceEntry] : []),
        ...(createUsage ? [{
          resource: {
            resourceType: "DeviceUseStatement",
            status: "completed",
            meta: { tag: [{ system: APP_TAG_SYSTEM, code: APP_TAG_CODE, display: APP_TAG_DISPLAY }] },
            device: { reference: deviceRef! },
            subject: { reference: SMART_PATIENT_ID ? `Patient/${SMART_PATIENT_ID}` : "Patient/example" },
            timingDateTime: nowISO,
            note: [{ text: mergedNote }],
          },
          request: { method: "POST", url: "DeviceUseStatement" },
        }] : []),
      ],
    };

      try {
        const result = await fhirTransaction(tx);
        
        setScanResult("");
        setCategory("");
        setProducts("");
        setSupplier("");
        setStockLevel(0);
        setIsAutoFilled(false);
        setReviewNotes("");
        setShowReview(false);

        alert(`✅ Saved to FHIR successfully!\nNotes: ${reviewNotes || "(none)"}\n\nData is being synchronized...`);
        
        setTimeout(() => {
          onSaved(result);
        }, 500);
      } catch (e: any) {
        setError(e?.message || String(e));
        setShowReview(true); // 出错时保持弹窗打开
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <div className="min-h-screen text-white">
      <ECGBackground />
      <div className="container mx-auto px-4 pt-20 pb-28">
        <h1 className="text-3xl font-bold mb-2">🏥 Medical Device Registration</h1>
        <p className="text-white/80 mb-6">
          Register medical devices by scanning barcodes or manual entry. Supports cardiovascular intervention devices with automatic identification.
        </p>

        <div className="max-w-2xl mx-auto">
          <div className="mb-6 text-center">
            <button
              onClick={() => setShowScanner(true)}
              className="px-8 py-4 bg-emerald-500 hover:bg-emerald-400 rounded-2xl text-black font-bold text-lg shadow-xl transform hover:scale-105 transition-transform"
            >
              📷 Scan Barcode to Auto-Fill
            </button>
          </div>

          {scanResult && (
            <div className="mb-6 p-4 bg-emerald-900/30 border border-emerald-500/40 rounded-xl">
              <div className="text-emerald-300 font-semibold mb-2">🎯 Barcode Scan Result</div>
              <div className="text-emerald-100 font-mono text-sm break-all mb-2">{scanResult}</div>
              {isAutoFilled && (
                <div className="text-emerald-400 text-sm">✅ Device information auto-filled from barcode database</div>
              )}
            </div>
          )}

          <div className="rounded-2xl bg-black/40 p-6 shadow-xl border border-white/10">
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">📋 Device Information Form</h2>
            <div className="space-y-4">
              <label className="block">
                <span className="text-sm text-white/70 font-medium">Device Category *</span>
                <input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g., Guide Catheter, Stent, Balloon"
                  className="mt-2 w-full rounded-xl bg-zinc-800/70 border border-zinc-700 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400"
                />
              </label>
              <label className="block">
                <span className="text-sm text-white/70 font-medium">Product Specification *</span>
                <input
                  value={products}
                  onChange={(e) => setProducts(e.target.value)}
                  placeholder="e.g., 6FR JR4.0, 3.5mm*30mm"
                  className="mt-2 w-full rounded-xl bg-zinc-800/70 border border-zinc-700 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400"
                />
              </label>
              <label className="block">
                <span className="text-sm text-white/70 font-medium">Manufacturer/Supplier</span>
                <input
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  placeholder="e.g., Medtronic, Boston Scientific, Terumo"
                  className="mt-2 w-full rounded-xl bg-zinc-800/70 border border-zinc-700 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400"
                />
              </label>
              <label className="block">
                <span className="text-sm text-white/70 font-medium">Stock Level</span>
                <input
                  value={stockLevel}
                  onChange={(e) => setStockLevel(parseInt(e.target.value) || 0)}
                  placeholder="Enter number of units"
                  type="number"
                  min="0"
                  className="mt-2 w-full rounded-xl bg-zinc-800/70 border border-zinc-700 px-4 py-3 text-white outline-none focus:ring-2 focus:ring-emerald-400 focus:border-emerald-400"
                />
              </label>
            </div>

            <div className="mt-8">
              <button 
                onClick={onSave} 
                className="w-full px-6 py-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 font-bold text-black shadow-xl transform hover:scale-105 transition-transform disabled:opacity-50 disabled:transform-none"
                disabled={!products.trim() || !category.trim() || isSubmitting}
              >
                💾 Save Medical Device to FHIR
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-900/50 border border-red-500/50 rounded-xl">
              <div className="text-red-300 text-sm">{error}</div>
            </div>
          )}

          <div className="mt-6 p-4 bg-blue-900/20 border border-blue-500/30 rounded-xl">
            <div className="text-blue-300 text-sm font-semibold mb-2">💡 Tip:</div>
            <div className="text-blue-200 text-sm">
              You can also manually fill in device information without scanning a barcode. 
              Just enter the device details and click Save. The system will create a new device record in FHIR.
            </div>
          </div>
        </div>
      </div>

      <ScannerModal
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onScanResult={handleScanResult}
      />

      <ScanReviewModal
        isOpen={showReview}
        barcode={scanResult}
        deviceInfo={{ Category: category, Products: products, Supplier: supplier, StockLevel: stockLevel }}
        notes={reviewNotes}
        setNotes={setReviewNotes}
        onCancel={() => setShowReview(false)}
        onSave={onSave}
      />
    </div>
  );
}
/* c8 ignore stop */


// Junlin Li====== Stock List Page ======
function StockPage({ onOpenDetail }: { onOpenDetail: (usage: any, device: any) => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [rows, setRows] = useState<Array<{ usage: any; device: any }>>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  
  const mergedRows = useMemo(() => {
    const map = new Map<string, { device: any; usages: any[]; count: number; when: string }>();
    for (const { usage, device } of rows) {
      const barcode = device?.identifier?.find((i: any) => i?.system === "urn:barcode")?.value || "";
      const name = device?.deviceName?.[0]?.name || "";
      const size = device?.property?.find((p: any) => p?.type?.text === "size")?.valueString || "";
      const manufacturer = device?.manufacturer || "";
      const key = (barcode || `${name}|${size}|${manufacturer}`).toLowerCase();

      const when =
        usage?.timingDateTime ||
        usage?.timingPeriod?.start ||
        usage?.meta?.lastUpdated ||
        device?.meta?.lastUpdated ||
        "";

      const exist = map.get(key);
      if (exist) {
        exist.count += 1;
        exist.usages.push(usage);
        if (when && (!exist.when || new Date(when) > new Date(exist.when))) {
          exist.when = when;
        }
      } else {
        map.set(key, { device, usages: [usage], count: 1, when });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.when ? new Date(a.when).getTime() : 0;
      const tb = b.when ? new Date(b.when).getTime() : 0;
      return tb - ta;
    });
  }, [rows]);

  async function updateDeviceStock(device: any, newStock: number) {
    if (!device?.id) {
      alert("Missing device ID.");
      return;
    }

    const updated = { ...device };
    updated.extension = [
      ...(updated.extension || []).filter((e: any) => e.url !== "urn:demo:stockLevel"),
      { url: "urn:demo:stockLevel", valueInteger: newStock },
    ];

    if (Array.isArray(updated.property)) {
      let found = false;
      updated.property = updated.property.map((p: any) => {
        if (p?.type?.text === "stockLevel") {
          found = true;
          return { ...p, valueQuantity: { value: newStock } };
        }
        return p;
      });
      if (!found) {
        updated.property.push({ type: { text: "stockLevel" }, valueQuantity: { value: newStock } });
      }
    } else {
      updated.property = [{ type: { text: "stockLevel" }, valueQuantity: { value: newStock } }];
    }

    const res = await fetch(`${FHIR_BASE}/Device/${device.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/fhir+json" },
      body: JSON.stringify(updated),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`Update stock failed: ${res.status} ${msg}`);
    }
  }

  useEffect(() => {
    async function load() {
      setError("");
      setLoading(true);
      try {
        let b: any;
        let usages: any[] = [];
        const pairs: Array<{ usage: any; device: any }> = [];

        const tag = `${encodeURIComponent(APP_TAG_SYSTEM)}|${encodeURIComponent(APP_TAG_CODE)}`;
        const patientParam = SMART_PATIENT_ID ? `Patient/${SMART_PATIENT_ID}` : "";

        // Helper to build pairs from a bundle that may include Devices
        const buildPairsFromBundle = (bundle: any) => {
          const resources = bundleEntries(bundle);
          const foundUsages = resources.filter((r: any) => r?.resourceType === "DeviceUseStatement");
          const deviceMap = new Map<string, any>();
          for (const r of resources) {
            if (r?.resourceType === "Device" && r?.id) deviceMap.set(`Device/${r.id}`, r);
          }
          for (const u of foundUsages) {
            const ref = u?.device?.reference as string | undefined;
            let device: any = null;
            if (ref && deviceMap.has(ref)) device = deviceMap.get(ref);
            pairs.push({ usage: u, device });
          }
          return foundUsages.length;
        };

        // 1) Prefer patient-scoped DUS with include
        if (patientParam) {
          try {
            b = await fhirSearch(`DeviceUseStatement?subject=${patientParam}&_include=DeviceUseStatement:device&_sort=-_lastUpdated`);
            if (!buildPairsFromBundle(b)) {
              // Try 'patient' alias in case server indexes that
              b = await fhirSearch(`DeviceUseStatement?patient=${patientParam}&_include=DeviceUseStatement:device&_sort=-_lastUpdated`);
              buildPairsFromBundle(b);
            }
          } catch {}
        }

        // 2) Fallback: tag-scoped DUS with include
        if (pairs.length === 0) {
          try {
            b = await fhirSearch(`DeviceUseStatement?_tag=${tag}&_include=DeviceUseStatement:device&_sort=-_lastUpdated`);
            buildPairsFromBundle(b);
          } catch {}
        }

        // 3) Optional R5 DeviceUsage (no include here; different name)
        if (pairs.length === 0 && patientParam) {
          try {
            b = await fhirSearch(`DeviceUsage?subject=${patientParam}&_sort=-_lastUpdated`);
            usages = bundleEntries(b);
          } catch {}
          if (pairs.length === 0 && usages.length === 0) {
            try {
              b = await fhirSearch(`DeviceUsage?patient=${patientParam}&_sort=-_lastUpdated`);
              usages = bundleEntries(b);
            } catch {}
          }
        }
        if (pairs.length === 0 && usages.length === 0) {
          try {
            b = await fhirSearch(`DeviceUsage?_tag=${tag}&_sort=-_lastUpdated`);
            usages = bundleEntries(b);
          } catch {}
        }

        if (pairs.length === 0 && usages.length > 0) {
          for (const u of usages) {
            const ref = u?.device?.reference as string | undefined;
            let device: any = null;
            if (ref) {
              const rel = ref.startsWith("http") ? ref.substring(ref.indexOf("/Device")) : ref;
              try { device = await fhirRead(rel.replace(/^[/]+/, "")); } catch {}
            }
            pairs.push({ usage: u, device });
          }
        }

        // 4) Final fallback: show devices as inventory when no usages are found yet
        if (pairs.length === 0) {
          try {
            const byDevices = await fhirSearch(`Device?_tag=${tag}&_sort=-_lastUpdated`);
            const devices = bundleEntries(byDevices);
            for (const d of devices) {
              pairs.push({ usage: { meta: { lastUpdated: d?.meta?.lastUpdated } }, device: d });
            }
          } catch (e) {
            console.warn("Device fallback failed", e);
          }
        }

        setRows(pairs);
        setLastRefresh(new Date());
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [refreshKey]);

  return (
    <div className="min-h-screen text-white">
      <ECGBackground />
      <div className="container mx-auto px-4 pt-20 pb-28">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold mb-2">📦 Stock Management</h1>
            <p className="text-white/80">View registered medical device records. Click on items to view detailed information.</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              disabled={loading}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-gray-600 disabled:cursor-not-allowed text-black font-semibold shadow-lg transition-all flex items-center gap-2"
            >
              🔄 Refresh
            </button>
            <div className="text-xs text-white/50">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </div>
          </div>
        </div>
        
        {loading && (
          <div className="text-center py-8">
            <div className="text-white/70">Loading device records...</div>
          </div>
        )}
        
        {error && (
          <div className="bg-red-900/50 border border-red-500/50 rounded-xl p-4 mb-6">
            <div className="text-red-300">Loading error: {error}</div>
          </div>
        )}
        
        {!loading && !error && (
          <div className="rounded-2xl overflow-hidden border border-white/10 bg-black/40">
            <table className="w-full">
              <thead className="bg-white/5">
                <tr>
                  <th className="text-left px-4 py-3">Time</th>
                  <th className="text-left px-4 py-3">Device Name</th>
                  <th className="text-left px-4 py-3">Category</th>
                  <th className="text-left px-4 py-3">Supplier</th>
                  <th className="text-left px-4 py-3">Qty</th>
                  <th className="text-left px-4 py-3">Stock</th>
                  <th className="text-left px-4 py-3">Action</th>
                  <th className="text-left px-4 py-3">Order</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-white/60">
                      <div className="text-lg mb-2">🏥 No Device Records</div>
                      <div>Please register medical devices in Equipment page</div>
                    </td>
                  </tr>
                )}
                {mergedRows.map(({ usages, device, count, when }, idx) => {
                  const whenText = when ? new Date(when).toLocaleString() : "--";
                  const displayName = device?.deviceName?.[0]?.name || "(Not filled)";
                  const category =
                    device?.type?.text ||
                    device?.property?.find((p: any) => p?.type?.text === "category")?.valueString ||
                    device?.extension?.find((e: any) => e?.url === "urn:demo:category")?.valueString ||
                    "Uncategorized";
                  const supplier =
                    device?.manufacturer ||
                    device?.property?.find((p: any) => p?.type?.text === "supplier")?.valueString ||
                    device?.extension?.find((e: any) => e?.url === "urn:demo:supplier")?.valueString ||
                    "Unknown Supplier";
                  const qty = count || 1;
                  const stockLevel =
                    device?.property?.find((p: any) => p?.type?.text === "stockLevel")?.valueQuantity?.value ||
                    device?.extension?.find((e: any) => e?.url === "urn:demo:stockLevel")?.valueInteger ||
                    0;
                  const isAutoIdentified = device?.note?.[0]?.text?.includes("(auto-identified)");

                  return (
                    <tr key={idx} className="border-t border-white/10 hover:bg-white/5">
                      <td className="px-4 py-3 whitespace-nowrap text-sm">{whenText}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span>{displayName}</span>
                          {isAutoIdentified && (
                            <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 rounded-full text-xs">
                              🎯 Auto-ID
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-1 bg-cyan-500/20 text-cyan-300 rounded-lg text-sm">{category}</span>
                      </td>
                      <td className="px-4 py-3 text-sm">{supplier}</td>
                      <td className="px-4 py-3 text-sm">{qty}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-1 rounded-lg text-sm font-semibold ${
                            stockLevel > 10
                              ? "bg-green-500/20 text-green-300"
                              : stockLevel > 5
                              ? "bg-yellow-500/20 text-yellow-300"
                              : stockLevel > 0
                              ? "bg-red-500/20 text-red-300"
                              : "bg-gray-500/20 text-gray-400"
                          }`}
                        >
                          {stockLevel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => onOpenDetail(usages[0], device)}
                          className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold"
                        >
                          📋 Details
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          className="px-3 py-1 rounded-lg bg-indigo-500/80 hover:bg-indigo-500 text-white text-sm"
                          onClick={async () => {
                            try {
                              const currentStock =
                                device?.property?.find((p: any) => p?.type?.text === "stockLevel")?.valueQuantity?.value ??
                                device?.extension?.find((e: any) => e?.url === "urn:demo:stockLevel")?.valueInteger ??
                                0;

                              const input = window.prompt("Enter quantity to order:");
                              if (input == null) return;
                              const delta = parseInt(input, 10);
                              if (!(delta > 0)) { alert("Please enter a positive integer."); return; }

                              await updateDeviceStock(device, currentStock + delta);
                              
                              setRefreshKey(k => k + 1);
                            } catch (e: any) {
                              alert(e?.message || String(e));
                            }
                          }}
                        >
                          🛒 Order
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        
        {!loading && !error && rows.length > 0 && (
          <div className="mt-6 text-center text-white/60 text-sm">
            Total {mergedRows.length} device groups
          </div>
        )}
      </div>
    </div>
  );
}

// Junlin Li====== Used List Page ======
function UsedListPage({ onOpenDetail }: { onOpenDetail: (usage: any, device: any) => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [rows, setRows] = useState<Array<{ usage: any; device: any }>>([]);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    async function load() {
      setError("");
      setLoading(true);
      try {
        let b: any;
        let usages: any[] = [];
        const pairs: Array<{ usage: any; device: any }> = [];

        const tag = `${encodeURIComponent(APP_TAG_SYSTEM)}|${encodeURIComponent(APP_TAG_CODE)}`;
        const patientParam = SMART_PATIENT_ID ? `Patient/${SMART_PATIENT_ID}` : "";

        const buildPairsFromBundle = (bundle: any) => {
          const resources = bundleEntries(bundle);
          const foundUsages = resources.filter((r: any) => r?.resourceType === "DeviceUseStatement");
          const deviceMap = new Map<string, any>();
          for (const r of resources) {
            if (r?.resourceType === "Device" && r?.id) deviceMap.set(`Device/${r.id}`, r);
          }
          for (const u of foundUsages) {
            const ref = u?.device?.reference as string | undefined;
            let device: any = null;
            if (ref && deviceMap.has(ref)) device = deviceMap.get(ref);
            pairs.push({ usage: u, device });
          }
          return foundUsages.length;
        };

        // 1) Patient-scoped DUS with include
        if (patientParam) {
          try {
            b = await fhirSearch(`DeviceUseStatement?subject=${patientParam}&_include=DeviceUseStatement:device&_sort=-_lastUpdated`);
            if (!buildPairsFromBundle(b)) {
              b = await fhirSearch(`DeviceUseStatement?patient=${patientParam}&_include=DeviceUseStatement:device&_sort=-_lastUpdated`);
              buildPairsFromBundle(b);
            }
          } catch {}
        }

        // 2) Tag-scoped DUS with include
        if (pairs.length === 0) {
          try {
            b = await fhirSearch(`DeviceUseStatement?_tag=${tag}&_include=DeviceUseStatement:device&_sort=-_lastUpdated`);
            buildPairsFromBundle(b);
          } catch {}
        }

        // 3) R5 DeviceUsage fallbacks
        if (pairs.length === 0 && patientParam) {
          try {
            b = await fhirSearch(`DeviceUsage?subject=${patientParam}&_sort=-_lastUpdated`);
            usages = bundleEntries(b);
          } catch {}
          if (pairs.length === 0 && usages.length === 0) {
            try {
              b = await fhirSearch(`DeviceUsage?patient=${patientParam}&_sort=-_lastUpdated`);
              usages = bundleEntries(b);
            } catch {}
          }
        }
        if (pairs.length === 0 && usages.length === 0) {
          try {
            b = await fhirSearch(`DeviceUsage?_tag=${tag}&_sort=-_lastUpdated`);
            usages = bundleEntries(b);
          } catch {}
        }

        if (pairs.length === 0 && usages.length > 0) {
          for (const u of usages) {
            const ref = u?.device?.reference as string | undefined;
            let device: any = null;
            if (ref) {
              const rel = ref.startsWith("http") ? ref.substring(ref.indexOf("/Device")) : ref;
              try { device = await fhirRead(rel.replace(/^[/]+/, "")); } catch {}
            }
            pairs.push({ usage: u, device });
          }
        }

        setRows(pairs);
        setLastRefresh(new Date());
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [refreshKey]);

  return (
    <div className="min-h-screen text-white">
      <ECGBackground />
      <div className="container mx-auto px-4 pt-20 pb-28">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold mb-2">📋 Used Devices List</h1>
            <p className="text-white/80">View devices that have already been used in medical procedures.</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              disabled={loading}
              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-gray-600 disabled:cursor-not-allowed text-black font-semibold shadow-lg transition-all flex items-center gap-2"
            >
              🔄 Refresh
            </button>
            <div className="text-xs text-white/50">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </div>
          </div>
        </div>

        {loading && (
          <div className="text-center py-8">
            <div className="text-white/70">Loading used device records...</div>
          </div>
        )}

        {error && (
          <div className="bg-red-900/50 border border-red-500/50 rounded-xl p-4 mb-6">
            <div className="text-red-300">Loading error: {error}</div>
          </div>
        )}

        {!loading && !error && (
          <div className="rounded-2xl overflow-hidden border border-white/10 bg-black/40">
            <table className="w-full">
              <thead className="bg-white/5">
                <tr>
                  <th className="text-left px-4 py-3">Usage Date</th>
                  <th className="text-left px-4 py-3">Device Name</th>
                  <th className="text-left px-4 py-3">Category</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-white/60">
                      <div className="text-lg mb-2">📋 No Used Devices</div>
                      <div>Devices marked as used will appear here</div>
                    </td>
                  </tr>
                )}
                {rows.map(({ usage, device }, idx) => {
                  const when = usage?.timingDateTime || usage?.timingPeriod?.start || usage?.meta?.lastUpdated;
                  const displayName = device?.deviceName?.[0]?.name || "(Not filled)";
                  const category = device?.type?.text ||
                    device?.property?.find((p: any) => p?.type?.text === "category")?.valueString ||
                    device?.extension?.find((e: any) => e?.url === "urn:demo:category")?.valueString ||
                    "Uncategorized";

                  return (
                    <tr key={idx} className="border-t border-white/10 hover:bg-white/5">
                      <td className="px-4 py-3 whitespace-nowrap text-sm">
                        {when ? new Date(when).toLocaleString() : "--"}
                      </td>
                      <td className="px-4 py-3">{displayName}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-1 bg-cyan-500/20 text-cyan-300 rounded-lg text-sm">
                          {category}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => onOpenDetail(usage, device)}
                          className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold text-sm"
                        >
                          📋 Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="mt-6 text-center text-white/60 text-sm">
            Total {rows.length} used device records
          </div>
        )}
      </div>
    </div>
  );
}

// Sunjia Zhang====== Detail Page ======
function DetailPage({ usage, device, onBack }: { usage: any; device: any; onBack: () => void }) {
  const deviceName = device?.deviceName?.[0]?.name || "(Not filled)";
  const category = device?.type?.text ||
                  device?.property?.find((p: any) => p?.type?.text === "category")?.valueString ||
                  device?.extension?.find((e: any) => e?.url === "urn:demo:category")?.valueString ||
                  "Uncategorized";
  const supplier = device?.manufacturer ||
                  device?.property?.find((p: any) => p?.type?.text === "supplier")?.valueString ||
                  device?.extension?.find((e: any) => e?.url === "urn:demo:supplier")?.valueString ||
                  "Unknown Supplier";
  const stockLevel = device?.property?.find((p: any) => p?.type?.text === "stockLevel")?.valueQuantity?.value ||
                    device?.extension?.find((e: any) => e?.url === "urn:demo:stockLevel")?.valueInteger ||
                    0;

  const barcode =
    device?.udiCarrier?.[0]?.carrierHRF ||
    device?.identifier?.find((id: any) => id.system === "urn:barcode")?.value ||
    "";
  const id = device?.id ? `Device/${device.id}` : "(unsaved?)";
  const usageIdPath = usage?.id ? `DeviceUseStatement/${usage.id}` : null;
  const deviceIdPath = device?.id ? `Device/${device.id}` : null;
  const isAutoIdentified = device?.note?.[0]?.text?.includes("(auto-identified)");

  const onDelete = async () => {
    if (!confirm("Are you sure you want to delete this medical device record and all related usage records? (This action cannot be undone)")) return;
    try {
      if (usageIdPath) await fhirDelete(usageIdPath);
      if (deviceIdPath) await fhirDelete(deviceIdPath);
      alert("✅ Medical device record and related usage records deleted successfully");
      onBack();
      setTimeout(() => location.reload(), 500);
    } catch (e: any) {
      alert(`Delete failed: ${e?.message || String(e)}`);
    }
  };

  const getStockLevelColor = (level: number) => {
    if (level > 10) return 'bg-green-500/20 text-green-300';
    if (level > 5) return 'bg-yellow-500/20 text-yellow-300';
    if (level > 0) return 'bg-red-500/20 text-red-300';
    return 'bg-gray-500/20 text-gray-400';
  };

  const getStockLevelText = (level: number) => {
    if (level > 10) return 'Adequate';
    if (level > 5) return 'Low';
    if (level > 0) return 'Critical';
    return 'Out of Stock';
  };

  return (
    <div className="min-h-screen text-white">
      <ECGBackground />
      <div className="container mx-auto px-4 pt-20 pb-28">
        <div className="mb-6 flex gap-3">
          <button onClick={onBack} className="px-4 py-2 rounded-xl bg-zinc-700 hover:bg-zinc-600">← Back to List</button>
          <button onClick={onDelete} className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500">🗑️ Delete Record</button>
        </div>

        <div className="mb-4">
          <h1 className="text-3xl font-bold mb-2">🏥 Medical Device Details</h1>
          {isAutoIdentified && (
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-500/20 border border-emerald-500/40 rounded-full text-emerald-300 text-sm">
              🎯 This device was auto-identified via barcode scanning
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-2xl bg-black/40 p-5 border border-white/10">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">🏥 Device Information</h2>
            <div className="space-y-4">
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Device Name/Specification:</span>
                <span className="text-white font-semibold text-lg">{deviceName}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Device Category:</span>
                <span className="px-3 py-1.5 bg-cyan-500/20 text-cyan-300 rounded-lg text-sm font-semibold inline-block w-fit">{category}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Manufacturer/Supplier:</span>
                <span className="text-white/90 font-medium">{supplier}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Stock Status:</span>
                <div className="flex items-center gap-3">
                  <span className={`px-3 py-1.5 rounded-lg text-sm font-bold ${getStockLevelColor(stockLevel)}`}>{stockLevel} units</span>
                  <span className={`px-2 py-1 rounded-full text-xs font-semibold ${getStockLevelColor(stockLevel)}`}>{getStockLevelText(stockLevel)}</span>
                </div>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Barcode/QR Code:</span>
                <div className="bg-zinc-800/50 p-3 rounded-lg font-mono text-sm break-all">{barcode || "No barcode information"}</div>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Device Resource ID:</span>
                <span className="text-white/70 font-mono text-sm">{id}</span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-black/40 p-5 border border-white/10">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">📊 Registration Record</h2>
            <div className="space-y-4">
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Record Status:</span>
                <span className="px-3 py-1.5 bg-green-500/20 text-green-300 rounded-lg text-sm font-semibold inline-block w-fit">
                  {usage?.status || "active"}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Registration Time:</span>
                <span className="text-white/90 font-medium">
                  {usage?.timingDateTime 
                    ? new Date(usage.timingDateTime).toLocaleString()
                    : usage?.timingPeriod?.start 
                    ? new Date(usage.timingPeriod.start).toLocaleString()
                    : "Not recorded"
                  }
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Associated Patient:</span>
                <span className="text-white/90 font-mono text-sm">
                  {usage?.subject?.reference || "Patient/example (demo)"}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-white/60 text-sm mb-1">Device Reference:</span>
                <span className="text-white/70 font-mono text-sm">
                  {usage?.device?.reference || "Not recorded"}
                </span>
              </div>
              {usage?.note && usage.note.length > 0 && (
                <div className="flex flex-col">
                  <span className="text-white/60 text-sm mb-1">Record Notes:</span>
                  <div className="bg-zinc-800/50 p-3 rounded-lg text-sm">{usage.note[0].text}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {stockLevel <= 5 && (
          <div className="mt-6 rounded-2xl bg-red-900/20 border border-red-500/40 p-4">
            <h3 className="text-lg font-semibold mb-2 text-red-300">⚠️ Stock Alert</h3>
            <p className="text-red-200">
              {stockLevel === 0 
                ? "This medical device is out of stock. Please replenish inventory immediately." 
                : `This medical device has low stock (${stockLevel} units remaining). Consider restocking soon.`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Together====== App ======
export default function App() {
  const [route, setRoute] = useState<"home" | "equipment" | "stock" | "used" | "detail">("home");
  const [detail, setDetail] = useState<{ usage: any; device: any } | null>(null);
  const [stockRefreshKey, setStockRefreshKey] = useState(0);
  const [usedRefreshKey, setUsedRefreshKey] = useState(0);

  useEffect(() => {
    const url = new URL(window.location.href);
    const iss = url.searchParams.get("iss");
    const launch = url.searchParams.get("launch");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    // If coming from SMART Launcher (EHR Launch), auto-start OAuth
    if (iss && launch && !(code || state)) {
      SMART.authorize({
        clientId: SMART_CLIENT_ID,
        scope: SMART_SCOPE,
        redirectUri: SMART_REDIRECT_URI,
        iss,
        launch,
      });
      return; // stop here; page will redirect
    }

    // Otherwise, if we're coming back from OAuth redirect or running standalone, init client if available
    tryInitSmartFromRedirect();
  }, []);

  const handleSaved = () => {
    setStockRefreshKey(k => k + 1);
    setUsedRefreshKey(k => k + 1);
    setRoute("used");
  };

  return (
    <div className="relative min-h-screen">
      <TopNav
        onHome={() => setRoute("home")}
        onEquipment={() => setRoute("equipment")}
        onStock={() => setRoute("stock")}
        onUsedList={() => setRoute("used")}
      />

      {route === "home" && <HomePage />}
      {route === "equipment" && <EquipmentPage onSaved={handleSaved} />}
      {route === "stock" && (
        <StockPage 
          key={stockRefreshKey}
          onOpenDetail={(usage, device) => { setDetail({ usage, device }); setRoute("detail"); }} 
        />
      )}
      {route === "used" && (
        <UsedListPage 
          key={usedRefreshKey}
          onOpenDetail={(usage, device) => { setDetail({ usage, device }); setRoute("detail"); }} 
        />
      )}
      {route === "detail" && detail && (
        <DetailPage 
          usage={detail.usage} 
          device={detail.device} 
          onBack={() => {
            setStockRefreshKey(k => k + 1);
            setUsedRefreshKey(k => k + 1);
            setRoute("used");
          }} 
        />
      )}

      <BottomNav onEquipment={() => setRoute("equipment")} onStock={() => setRoute("stock")} onUsedList={() => setRoute("used")} />

      <div className="fixed top-3 right-3 z-50 text-[11px] text-white/70 bg-black/50 border border-white/10 px-2.5 py-1 rounded-full">
        <div className="flex items-center gap-2">
          <span>🏥 FHIR: {(SMART_SERVER_URL || FHIR_BASE).replace("https://", "")}</span>
          {SMART_PATIENT_ID ? (
            <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">SMART ✓ Patient/{SMART_PATIENT_ID}</span>
          ) : (
            <button onClick={smartAuthorizeFlow} className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">🔐 Connect</button>
          )}
        </div>
      </div>
    </div>
  );
}
