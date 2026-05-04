// AWS Region Converter
// Local data source: regions.json (edit to add/update regions)
// Live data sources (optional, graceful degradation):
//   - AWS Regional Services Table: adds service availability count
//   - AWS IP Ranges: adds IP prefix counts, services with IP presence, border groups

const LIVE_ENDPOINTS = {
  services: "https://api.regional-table.region-services.aws.a2z.com/index.json",
  ipRanges: "https://ip-ranges.amazonaws.com/ip-ranges.json",
};

const state = {
  regions: [],
  liveData: null, // Map<regionCode, { serviceCount, services[] }>
  ipData: null,   // Map<regionCode, { v4Count, v6Count, services[], borderGroups[] }>
  liveFetchedAt: null,
  ipFetchedAt: null,
  ipSyncDate: null, // AWS-reported createDate from ip-ranges.json
  coverage: { missing: [], stale: [] },
};

const els = {
  search: document.getElementById("searchInput"),
  results: document.getElementById("results"),
  resultCount: document.getElementById("resultCount"),
  empty: document.getElementById("emptyState"),
  refreshBtn: document.getElementById("refreshBtn"),
  liveStatus: document.getElementById("liveStatus"),
  coverageAlert: document.getElementById("coverageAlert"),
};

// ---------- Data loading ----------

async function loadLocalRegions() {
  const res = await fetch("regions.json");
  if (!res.ok) throw new Error(`Failed to load regions.json: ${res.status}`);
  const data = await res.json();
  state.regions = data.regions || [];
}

async function loadLiveData({ silent = false } = {}) {
  if (!silent) setLiveStatus("Fetching live AWS data…", "warning");
  els.refreshBtn.classList.add("loading");
  els.refreshBtn.disabled = true;

  const results = await Promise.allSettled([
    fetchServicesTable(),
    fetchIpRanges(),
  ]);

  const servicesResult = results[0];
  const ipResult = results[1];

  const statusParts = [];
  let level = "success";

  if (servicesResult.status === "fulfilled") {
    statusParts.push(`${state.liveData.size} regions verified`);
  } else {
    console.warn("Services fetch failed:", servicesResult.reason);
    statusParts.push("services table unavailable");
    level = "warning";
  }

  if (ipResult.status === "fulfilled") {
    const syncLabel = state.ipSyncDate ? ` (AWS sync ${state.ipSyncDate})` : "";
    statusParts.push(`IP ranges for ${state.ipData.size} regions${syncLabel}`);
  } else {
    console.warn("IP ranges fetch failed:", ipResult.reason);
    statusParts.push("IP ranges unavailable");
    level = level === "success" ? "warning" : level;
  }

  if (servicesResult.status === "rejected" && ipResult.status === "rejected") {
    level = "error";
  }

  const timeStr = new Date().toLocaleTimeString();
  setLiveStatus(`Live data: ${statusParts.join(" · ")} at ${timeStr}`, level);

  els.refreshBtn.classList.remove("loading");
  els.refreshBtn.disabled = false;

  checkCoverage();
}

async function fetchServicesTable() {
  const res = await fetch(LIVE_ENDPOINTS.services);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const byRegion = new Map();
  for (const item of data.prices || []) {
    const regionCode = item.attributes?.["aws:region"];
    const serviceName = item.attributes?.["aws:serviceName"];
    if (!regionCode) continue;
    if (!byRegion.has(regionCode)) {
      byRegion.set(regionCode, { serviceCount: 0, services: [] });
    }
    const entry = byRegion.get(regionCode);
    entry.serviceCount += 1;
    if (serviceName) entry.services.push(serviceName);
  }

  state.liveData = byRegion;
  state.liveFetchedAt = new Date();
}

async function fetchIpRanges() {
  const res = await fetch(LIVE_ENDPOINTS.ipRanges);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const byRegion = new Map();

  const ensureEntry = (regionCode) => {
    if (!byRegion.has(regionCode)) {
      byRegion.set(regionCode, {
        v4Prefixes: [], // [{ prefix, service, borderGroup }]
        v6Prefixes: [],
        services: new Set(),
        borderGroups: new Set(),
      });
    }
    return byRegion.get(regionCode);
  };

  for (const p of data.prefixes || []) {
    if (!p.region) continue;
    const entry = ensureEntry(p.region);
    entry.v4Prefixes.push({
      prefix: p.ip_prefix,
      service: p.service,
      borderGroup: p.network_border_group,
    });
    if (p.service) entry.services.add(p.service);
    if (p.network_border_group) entry.borderGroups.add(p.network_border_group);
  }
  for (const p of data.ipv6_prefixes || []) {
    if (!p.region) continue;
    const entry = ensureEntry(p.region);
    entry.v6Prefixes.push({
      prefix: p.ipv6_prefix,
      service: p.service,
      borderGroup: p.network_border_group,
    });
    if (p.service) entry.services.add(p.service);
    if (p.network_border_group) entry.borderGroups.add(p.network_border_group);
  }

  // Sort for stable rendering
  for (const entry of byRegion.values()) {
    entry.services = [...entry.services].sort();
    entry.borderGroups = [...entry.borderGroups].sort();
    entry.v4Prefixes.sort((a, b) => a.prefix.localeCompare(b.prefix));
    entry.v6Prefixes.sort((a, b) => a.prefix.localeCompare(b.prefix));
    // Convenience counts
    entry.v4Count = entry.v4Prefixes.length;
    entry.v6Count = entry.v6Prefixes.length;
  }

  state.ipData = byRegion;
  state.ipFetchedAt = new Date();
  state.ipSyncDate = formatAwsSyncDate(data.createDate);
}

function formatAwsSyncDate(raw) {
  // AWS format: "2026-05-04-03-57-06" -> "2026-05-04"
  if (!raw || typeof raw !== "string") return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : raw;
}

// ---------- Coverage check ----------
// Warns if AWS endpoints return region codes that are missing from regions.json,
// so the operator knows to update the local file.

function checkCoverage() {
  const local = new Set(state.regions.map((r) => r.regionCode));

  // Build a map of awsRegionCode -> which sources reported it
  const sources = new Map();
  const note = (code, source) => {
    if (!code || code === "GLOBAL") return;
    if (!sources.has(code)) sources.set(code, new Set());
    sources.get(code).add(source);
  };

  if (state.liveData) {
    for (const code of state.liveData.keys()) note(code, "services");
  }
  if (state.ipData) {
    for (const code of state.ipData.keys()) note(code, "ip-ranges");
  }

  // Missing: in live data but not in local regions.json
  const missing = [...sources.entries()]
    .filter(([code]) => !local.has(code))
    .map(([code, srcSet]) => ({ code, sources: [...srcSet].sort() }))
    .sort((a, b) => a.code.localeCompare(b.code));

  // Stale: in local regions.json with a publicly-reported scope but absent from BOTH live sources.
  // Only commercial scopes are expected to appear in AWS's public endpoints.
  // retail, govcloud, china, iso, sovereign are intentionally not published there.
  const publicScopes = new Set(["commercial", "commercial-optin"]);
  const stale = state.regions
    .filter(
      (r) =>
        publicScopes.has(r.scope) &&
        (state.liveData || state.ipData) &&
        !(state.liveData && state.liveData.has(r.regionCode)) &&
        !(state.ipData && state.ipData.has(r.regionCode))
    )
    .map((r) => ({ airport: r.airport, regionCode: r.regionCode, longName: r.longName }));

  state.coverage = { missing, stale };
  renderCoverageAlert({ missing, stale });
}

function renderCoverageAlert({ missing, stale }) {
  if (!els.coverageAlert) return;

  if (!missing.length && !stale.length) {
    els.coverageAlert.className = "coverage-alert hidden";
    els.coverageAlert.innerHTML = "";
    return;
  }

  const totalDrift = missing.length + stale.length;
  const level = missing.length > 0 ? "missing" : "stale";
  const icon = missing.length > 0 ? "⚠️" : "ℹ️";
  const summary = missing.length > 0
    ? `${missing.length} missing region${missing.length === 1 ? "" : "s"}`
    : `${stale.length} not reported`;

  const sections = [];

  if (missing.length) {
    const rows = missing
      .map(
        (m) => `
        <tr>
          <td><code>${escapeHtml(m.code)}</code></td>
          <td>${m.sources.map((s) => `<span class="az-chip">${escapeHtml(s)}</span>`).join(" ")}</td>
        </tr>`
      )
      .join("");
    sections.push(`
      <div class="coverage-section coverage-missing">
        <h3>⚠️ ${missing.length} missing from <code>regions.json</code></h3>
        <p>AWS is publishing these region codes. Add them to keep the local file in sync.</p>
        <table class="coverage-table">
          <thead><tr><th>Region code</th><th>Reported by</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="card-actions" style="margin-top:0.75rem">
          <button type="button" class="action-btn accent" data-action="copy-ai-prompt">📋 Copy AI prompt</button>
          <span class="detail-label" style="align-self:center">Paste into Claude, ChatGPT, Kiro…</span>
        </div>
      </div>
    `);
  }

  if (stale.length) {
    const rows = stale
      .map(
        (s) => `
        <tr>
          <td><strong>${escapeHtml(s.airport)}</strong></td>
          <td><code>${escapeHtml(s.regionCode)}</code></td>
          <td>${escapeHtml(s.longName || "")}</td>
        </tr>`
      )
      .join("");
    sections.push(`
      <div class="coverage-section coverage-stale">
        <h3>ℹ️ ${stale.length} not reported by AWS</h3>
        <p>These entries are marked commercial but neither live endpoint is reporting them. Verify they're still correct.</p>
        <table class="coverage-table">
          <thead><tr><th>Airport</th><th>Region code</th><th>Long name</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  els.coverageAlert.className = `coverage-alert visible coverage-${level}`;
  els.coverageAlert.innerHTML = `
    <button type="button" class="coverage-pill" data-action="toggle-coverage" aria-expanded="false" title="${totalDrift} drift item${totalDrift === 1 ? "" : "s"} detected — click to expand">
      <span class="coverage-pill-icon">${icon}</span>
      <span class="coverage-pill-label">${escapeHtml(summary)}</span>
      <span class="coverage-pill-chevron" aria-hidden="true">▾</span>
    </button>
    <div class="coverage-details" hidden>
      <div class="coverage-details-header">
        <span class="detail-label">Data drift detected</span>
        <button type="button" class="coverage-close" data-action="toggle-coverage" aria-label="Collapse">×</button>
      </div>
      ${sections.join("")}
    </div>
  `;
}

// Build a self-contained prompt an AI model can act on to update regions.json.
function buildAiPrompt({ missing, stale }) {
  const sample = state.regions.find((r) => r.regionCode === "eu-central-1")
    || state.regions[0]
    || null;

  const missingList = missing.map((m) => `- ${m.code}  (reported by: ${m.sources.join(", ")})`).join("\n");
  const staleList = stale.length
    ? stale.map((s) => `- ${s.airport} / ${s.regionCode} — ${s.longName}`).join("\n")
    : "(none)";

  const sampleJson = sample ? JSON.stringify(sample, null, 2) : "{ ... }";

  return `You are helping maintain a community-curated AWS regions JSON file for a tool called "AWS Regionator".

## Context

The file \`regions.json\` contains metadata for every AWS region: airport code, region code, long name, partition, scope, city, country, timezone, launch date, physical availability zone codes, and search aliases.

Two AWS public endpoints are used to detect drift:
- https://api.regional-table.region-services.aws.a2z.com/index.json  (service availability)
- https://ip-ranges.amazonaws.com/ip-ranges.json  (IP prefix assignments)

A diff against the local file surfaced the following drift.

## Regions present in AWS data but MISSING from regions.json (${missing.length})

${missingList || "(none)"}

## Entries in regions.json NOT reported by either AWS endpoint (${stale.length})

${staleList}

## Your task

1. For each MISSING region code above, research it and produce a complete JSON object matching the schema shown below.
2. For each NOT-REPORTED entry, either:
   - Confirm it is still correct (explain why, e.g. "retail region, not public"), OR
   - Flag it as incorrect with a suggested fix.

Return ONLY:
- A JSON array of new entries to INSERT into the \`regions\` array of regions.json.
- A short bullet list of recommended edits/removals for the not-reported entries.

## Required schema (one entry per region)

Fields:
- airport (string, 3-letter IATA-style airport code closest to the region's data center city)
- regionCode (string, e.g. "us-east-1")
- longName (string, official name like "US East (N. Virginia)")
- partition (string): one of "aws" | "aws-cn" | "aws-us-gov" | "aws-iso" | "aws-iso-b" | "aws-iso-e" | "aws-iso-f" | "aws-eusc"
- scope (string): one of
    - "commercial"        (always-on commercial region, appears in \`aws account list-regions\`)
    - "commercial-optin"  (commercial but requires opt-in)
    - "govcloud"          (AWS GovCloud US)
    - "china"             (operated by Sinnet / NWCD)
    - "iso"               (ISO / classified partitions)
    - "sovereign"         (European Sovereign Cloud)
    - "retail"            (internal Amazon, not customer-facing)
- city (string)
- country (string, full name)
- countryCode (string, ISO 3166-1 alpha-2)
- timezone (string, IANA format like "Europe/Berlin")
- status (string): "GA" | "BUILD" | "CLOSING" | "CLOSED"
- launchDate (string, ISO date "YYYY-MM-DD")
- availabilityZones (string[], physical AZ codes like "FRA52". If you don't know them, use an empty array [])
- aliases (string[], alternative search terms users might type)

## Reference example

\`\`\`json
${sampleJson}
\`\`\`

## Output format

\`\`\`json
[
  { ...new region 1... },
  { ...new region 2... }
]
\`\`\`

Followed by (if applicable):

**Not-reported entries review:**
- <airport> / <regionCode>: <keep | remove | update, with reason>

Where to paste the new entries: append them to the \`regions\` array in \`source/regions.json\`, keeping the array sorted by airport code.`;
}

function setLiveStatus(message, level) {
  els.liveStatus.textContent = message;
  els.liveStatus.className = `live-status visible ${level}`;
}

// ---------- Search ----------

function buildSearchIndex(region) {
  // All searchable strings for this region, lowercased.
  const parts = [
    region.airport,
    region.regionCode,
    region.longName,
    region.partition,
    region.scope,
    region.city,
    region.country,
    region.countryCode,
    region.timezone,
    ...(region.aliases || []),
    ...(region.availabilityZones || []),
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function scoreMatch(region, query) {
  // Higher score = better match. 0 = no match.
  if (!query) return 1;
  const q = query.toLowerCase().trim();
  const airport = (region.airport || "").toLowerCase();
  const regionCode = (region.regionCode || "").toLowerCase();
  const city = (region.city || "").toLowerCase();
  const longName = (region.longName || "").toLowerCase();
  const country = (region.country || "").toLowerCase();
  const index = buildSearchIndex(region);

  if (airport === q) return 100;
  if (regionCode === q) return 95;
  if (city === q) return 85;
  if (country === q) return 80;
  if (airport.startsWith(q)) return 70;
  if (regionCode.startsWith(q)) return 65;
  if (city.startsWith(q)) return 60;
  if (longName.startsWith(q)) return 55;
  if (country.startsWith(q)) return 50;
  if (index.includes(q)) return 20;
  return 0;
}

function search(query) {
  return state.regions
    .map((region) => ({ region, score: scoreMatch(region, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.region.airport.localeCompare(b.region.airport);
    })
    .map((r) => r.region);
}

// ---------- Rendering ----------

function highlight(text, query) {
  if (!query || !text) return escapeHtml(text || "");
  const q = query.trim();
  if (!q) return escapeHtml(text);
  const safeText = escapeHtml(text);
  const safeQuery = escapeRegex(q);
  return safeText.replace(new RegExp(safeQuery, "gi"), (m) => `<mark>${m}</mark>`);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderCard(region, query) {
  const liveInfo = state.liveData?.get(region.regionCode);
  const ipInfo = state.ipData?.get(region.regionCode);

  const liveBadge = liveInfo
    ? `<button type="button" class="live-badge clickable" title="Click to view all ${liveInfo.serviceCount} services" data-action="view-services" data-region="${escapeHtml(region.regionCode)}">✓ ${liveInfo.serviceCount} services</button>`
    : "";

  const ipBadge = ipInfo
    ? `<button type="button" class="ip-badge clickable" title="Click to view all ${(ipInfo.v4Count + ipInfo.v6Count).toLocaleString()} IP prefixes" data-action="view-prefixes" data-region="${escapeHtml(region.regionCode)}">🌐 ${(ipInfo.v4Count + ipInfo.v6Count).toLocaleString()} IP prefixes</button>`
    : "";

  const details = [
    { label: "City", value: region.city },
    { label: "Country", value: region.country ? `${region.country} (${region.countryCode})` : "", copy: region.country },
    { label: "Timezone", value: region.timezone },
    { label: "Launched", value: region.launchDate },
    { label: "Status", value: region.status },
  ]
    .filter((d) => d.value)
    .map(
      (d) => `
      <div class="detail">
        <span class="detail-label">${d.label}</span>
        <span class="detail-value">${copyable(d.copy ?? d.value, highlight(d.value, query))}</span>
      </div>`
    )
    .join("");

  const azs = (region.availabilityZones || [])
    .map((az) => copyable(az, escapeHtml(az), "az-chip"))
    .join("");

  const aliasLine = region.aliases && region.aliases.length
    ? `<div class="detail"><span class="detail-label">Also Known As</span><span class="detail-value">${region.aliases.map(a => copyable(a, highlight(a, query))).join(", ")}</span></div>`
    : "";

  // IP / network details (only if we have data)
  let networkSection = "";
  if (ipInfo) {
    const borderChips = ipInfo.borderGroups
      .map((bg) => copyable(bg, escapeHtml(bg), "az-chip"))
      .join("");
    networkSection = `
      <div class="azs">
        <span class="detail-label">Network (from ip-ranges.json)</span>
        <div class="network-grid">
          <div><strong>${ipInfo.v4Count.toLocaleString()}</strong> IPv4 prefixes</div>
          <div><strong>${ipInfo.v6Count.toLocaleString()}</strong> IPv6 prefixes</div>
          <div><strong>${ipInfo.services.length}</strong> services with IPs</div>
          <div><strong>${ipInfo.borderGroups.length}</strong> border group${ipInfo.borderGroups.length === 1 ? "" : "s"}</div>
        </div>
        ${borderChips ? `<div class="az-list" style="margin-top:0.5rem">${borderChips}</div>` : ""}
        <div class="card-actions">
          <button type="button" class="action-btn" data-action="view-prefixes" data-region="${escapeHtml(region.regionCode)}">View all IP prefixes →</button>
          ${liveInfo ? `<button type="button" class="action-btn" data-action="view-services" data-region="${escapeHtml(region.regionCode)}">View all services →</button>` : ""}
          <button type="button" class="action-btn" data-action="view-ip-services" data-region="${escapeHtml(region.regionCode)}">View services with IPs →</button>
        </div>
      </div>
    `;
  } else if (liveInfo) {
    networkSection = `
      <div class="azs">
        <div class="card-actions">
          <button type="button" class="action-btn" data-action="view-services" data-region="${escapeHtml(region.regionCode)}">View all ${liveInfo.serviceCount} services →</button>
        </div>
      </div>
    `;
  }

  return `
    <article class="region-card">
      <div class="region-header">
        <div class="region-title">
          ${copyable(region.airport, highlight(region.airport, query), "airport-code")}
          ${copyable(region.regionCode, highlight(region.regionCode, query), "region-code")}
          ${copyable(region.longName, highlight(region.longName, query), "long-name")}
          ${copyable(region.partition, escapeHtml(region.partition), "partition-badge", `Partition: ${region.partition}`)}
          ${region.scope ? copyable(region.scope, escapeHtml(region.scope), `scope-badge scope-${region.scope}`, `Scope: ${region.scope}`) : ""}
          ${liveBadge}
          ${ipBadge}
        </div>
      </div>
      <div class="region-details">
        ${details}
        ${aliasLine}
      </div>
      ${azs ? `<div class="azs"><span class="detail-label">Availability Zones</span><div class="az-list">${azs}</div></div>` : ""}
      ${networkSection}
    </article>
  `;
}

// Wraps any value in a copy-to-clipboard span.
// copyValue: raw text to copy (string)
// innerHtml: already-escaped/highlighted HTML to display
// extraClass: optional additional CSS classes
// titleOverride: optional custom tooltip
function copyable(copyValue, innerHtml, extraClass = "", titleOverride = null) {
  if (copyValue === undefined || copyValue === null || copyValue === "") {
    return innerHtml || "";
  }
  const title = titleOverride || `Click to copy: ${copyValue}`;
  const cls = `copyable ${extraClass}`.trim();
  return `<span class="${cls}" data-copy="${escapeHtml(String(copyValue))}" title="${escapeHtml(title)}">${innerHtml}</span>`;
}

function render() {
  const query = els.search.value.trim();
  const matches = search(query);

  els.resultCount.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"}`;

  if (matches.length === 0) {
    els.results.innerHTML = "";
    els.empty.classList.remove("hidden");
    return;
  }

  els.empty.classList.add("hidden");
  els.results.innerHTML = matches.map((r) => renderCard(r, query)).join("");
}

// ---------- Disclaimer banner ----------

const DISCLAIMER_COOKIE = "regionator_disclaimer_ack";
const DISCLAIMER_MAX_AGE_DAYS = 365;

function getCookie(name) {
  const prefix = name + "=";
  const parts = (document.cookie || "").split(";");
  for (const p of parts) {
    const t = p.trim();
    if (t.startsWith(prefix)) return decodeURIComponent(t.slice(prefix.length));
  }
  return null;
}

function setCookie(name, value, maxAgeDays) {
  const maxAge = maxAgeDays * 24 * 60 * 60;
  // SameSite=Lax is fine for a first-party dismissal flag.
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

function hasAcknowledgedDisclaimer() {
  if (getCookie(DISCLAIMER_COOKIE) === "1") return true;
  // Fallback: localStorage in case cookies are blocked (e.g. file://)
  try {
    return window.localStorage.getItem(DISCLAIMER_COOKIE) === "1";
  } catch (_) {
    return false;
  }
}

function acknowledgeDisclaimer() {
  setCookie(DISCLAIMER_COOKIE, "1", DISCLAIMER_MAX_AGE_DAYS);
  try { window.localStorage.setItem(DISCLAIMER_COOKIE, "1"); } catch (_) { /* ignore */ }
}

function initDisclaimerBanner() {
  const banner = document.getElementById("disclaimerBanner");
  const dismiss = document.getElementById("disclaimerDismiss");
  if (!banner || !dismiss) return Promise.resolve();
  if (hasAcknowledgedDisclaimer()) return Promise.resolve();

  // Block interaction with the rest of the page until dismissed
  document.body.classList.add("no-scroll");
  banner.classList.remove("hidden");
  requestAnimationFrame(() => banner.classList.add("visible"));
  setTimeout(() => dismiss.focus(), 50);

  return new Promise((resolve) => {
    dismiss.addEventListener("click", () => {
      acknowledgeDisclaimer();
      banner.classList.remove("visible");
      document.body.classList.remove("no-scroll");
      setTimeout(() => {
        banner.classList.add("hidden");
        resolve();
      }, 200);
    }, { once: true });
  });
}

// ---------- Copy-to-clipboard & toast ----------

async function copyToClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback for older browsers / non-HTTPS contexts
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }
}

let toastTimer = null;
function showToast(message, level = "success") {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast toast-${level} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 1800);
}

function truncate(s, max) {
  if (!s) return s;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------- Modal ----------

function openModal({ title, subtitle, bodyHtml, copyText }) {
  const existing = document.getElementById("modalBackdrop");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "modalBackdrop";
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <div>
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<div class="modal-subtitle">${escapeHtml(subtitle)}</div>` : ""}
        </div>
        <div class="modal-header-actions">
          ${copyText ? `<button type="button" class="action-btn" id="modalCopyBtn">Copy all</button>` : ""}
          <button type="button" class="modal-close" aria-label="Close" id="modalCloseBtn">×</button>
        </div>
      </header>
      <div class="modal-filter">
        <input type="search" id="modalFilter" placeholder="Filter this list…" autocomplete="off" />
      </div>
      <div class="modal-body" id="modalBody">${bodyHtml}</div>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.body.classList.add("no-scroll");

  const close = () => {
    backdrop.remove();
    document.body.classList.remove("no-scroll");
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector("#modalCloseBtn").addEventListener("click", close);

  if (copyText) {
    const btn = backdrop.querySelector("#modalCopyBtn");
    btn.addEventListener("click", async () => {
      const ok = await copyToClipboard(copyText);
      if (ok) {
        const lines = copyText.split("\n").length;
        showToast(`Copied ${lines} line${lines === 1 ? "" : "s"}`);
        const orig = btn.textContent;
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = orig; }, 1200);
      } else {
        showToast("Copy failed", "error");
      }
    });
  }

  // In-modal live filter
  const filterInput = backdrop.querySelector("#modalFilter");
  const body = backdrop.querySelector("#modalBody");
  filterInput.addEventListener("input", () => {
    const q = filterInput.value.trim().toLowerCase();
    body.querySelectorAll("[data-filter]").forEach((el) => {
      const haystack = el.getAttribute("data-filter").toLowerCase();
      el.style.display = !q || haystack.includes(q) ? "" : "none";
    });
  });
  setTimeout(() => filterInput.focus(), 50);
}

// ---------- Drill-down views ----------

function showAllServices(regionCode) {
  const liveInfo = state.liveData?.get(regionCode);
  if (!liveInfo) return;
  const services = [...liveInfo.services].sort((a, b) => a.localeCompare(b));
  const rows = services.map(
    (s) => `<li class="modal-row" data-filter="${escapeHtml(s)}">${copyable(s, escapeHtml(s))}</li>`
  ).join("");
  openModal({
    title: `${regionCode} — Services`,
    subtitle: `${services.length} services from Regional Services Table`,
    bodyHtml: `<ul class="modal-list">${rows}</ul>`,
    copyText: services.join("\n"),
  });
}

function showAllPrefixes(regionCode) {
  const ipInfo = state.ipData?.get(regionCode);
  if (!ipInfo) return;

  const row = (p, version) => `
    <tr data-filter="${escapeHtml(p.prefix + ' ' + (p.service || '') + ' ' + (p.borderGroup || ''))}">
      <td>${copyable(p.prefix, `<code>${escapeHtml(p.prefix)}</code>`)}</td>
      <td><span class="az-chip">${version}</span></td>
      <td>${p.service ? copyable(p.service, escapeHtml(p.service)) : ""}</td>
      <td>${p.borderGroup ? copyable(p.borderGroup, escapeHtml(p.borderGroup)) : ""}</td>
    </tr>
  `;

  const rows =
    ipInfo.v4Prefixes.map((p) => row(p, "IPv4")).join("") +
    ipInfo.v6Prefixes.map((p) => row(p, "IPv6")).join("");

  const tableHtml = `
    <table class="modal-table">
      <thead>
        <tr>
          <th>Prefix</th>
          <th>Version</th>
          <th>Service</th>
          <th>Border Group</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  const allText = [...ipInfo.v4Prefixes, ...ipInfo.v6Prefixes]
    .map((p) => p.prefix)
    .join("\n");

  openModal({
    title: `${regionCode} — IP Prefixes`,
    subtitle: `${ipInfo.v4Count.toLocaleString()} IPv4 · ${ipInfo.v6Count.toLocaleString()} IPv6 · ${ipInfo.services.length} services · ${ipInfo.borderGroups.length} border groups`,
    bodyHtml: tableHtml,
    copyText: allText,
  });
}

function showIpServices(regionCode) {
  const ipInfo = state.ipData?.get(regionCode);
  if (!ipInfo) return;

  const counts = new Map();
  const bump = (p) => {
    const s = p.service || "(unknown)";
    counts.set(s, (counts.get(s) || 0) + 1);
  };
  ipInfo.v4Prefixes.forEach(bump);
  ipInfo.v6Prefixes.forEach(bump);

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rows = sorted.map(([s, n]) => `
    <tr data-filter="${escapeHtml(s)}">
      <td>${copyable(s, escapeHtml(s))}</td>
      <td class="num">${n.toLocaleString()}</td>
    </tr>
  `).join("");

  openModal({
    title: `${regionCode} — Services with IP presence`,
    subtitle: `${sorted.length} services · from ip-ranges.json`,
    bodyHtml: `
      <table class="modal-table">
        <thead><tr><th>Service</th><th class="num">Prefix count</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `,
    copyText: sorted.map(([s, n]) => `${s}\t${n}`).join("\n"),
  });
}

// ---------- Events ----------

// Global click handler for [data-copy] elements.
// Runs in capture phase so it takes priority over inner handlers.
document.addEventListener("click", async (e) => {
  const copyEl = e.target.closest("[data-copy]");
  if (!copyEl) return;
  // If the click landed on a nested action button inside a copyable parent,
  // let the action handler take over instead.
  const actionEl = e.target.closest("[data-action]");
  if (actionEl && copyEl.contains(actionEl)) return;
  e.preventDefault();
  e.stopPropagation();
  const text = copyEl.getAttribute("data-copy");
  const ok = await copyToClipboard(text);
  if (ok) {
    showToast(`Copied: ${truncate(text, 60)}`);
    copyEl.classList.add("copied-flash");
    setTimeout(() => copyEl.classList.remove("copied-flash"), 400);
  } else {
    showToast("Copy failed — your browser blocked clipboard access", "error");
  }
}, true);

els.search.addEventListener("input", render);
els.refreshBtn.addEventListener("click", async () => {
  await loadLiveData();
  render();
});

// Delegated click handler for card action buttons
els.results.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");
  const region = btn.getAttribute("data-region");
  if (!region) return;
  if (action === "view-services") showAllServices(region);
  else if (action === "view-prefixes") showAllPrefixes(region);
  else if (action === "view-ip-services") showIpServices(region);
});

// Coverage alert action handler (toggle expand / Copy AI prompt)
if (els.coverageAlert) {
  els.coverageAlert.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");

    if (action === "toggle-coverage") {
      const details = els.coverageAlert.querySelector(".coverage-details");
      const pill = els.coverageAlert.querySelector(".coverage-pill");
      if (!details) return;
      const isOpen = !details.hasAttribute("hidden");
      if (isOpen) {
        details.setAttribute("hidden", "");
        els.coverageAlert.classList.remove("expanded");
        pill?.setAttribute("aria-expanded", "false");
      } else {
        details.removeAttribute("hidden");
        els.coverageAlert.classList.add("expanded");
        pill?.setAttribute("aria-expanded", "true");
      }
      return;
    }

    if (action === "copy-ai-prompt") {
      const prompt = buildAiPrompt(state.coverage);
      const ok = await copyToClipboard(prompt);
      if (ok) {
        const origLabel = btn.textContent;
        btn.textContent = "✓ Prompt copied";
        showToast(`Copied AI prompt (${prompt.length.toLocaleString()} chars)`);
        setTimeout(() => { btn.textContent = origLabel; }, 2500);
      } else {
        showToast("Copy failed", "error");
      }
    }
  });
}

// ---------- Init ----------

(async function init() {
  // Block tool usage until the user acknowledges the disclaimer (first visit only).
  await initDisclaimerBanner();

  try {
    await loadLocalRegions();
    render();
  } catch (err) {
    els.results.innerHTML = `<div class="live-status visible error">Failed to load regions.json: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Fetch live data in the background — don't block first render.
  loadLiveData({ silent: false }).then(render);
})();
