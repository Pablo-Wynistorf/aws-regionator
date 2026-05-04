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
  globeSvg: document.getElementById("globeSvg"),
  globeTooltip: document.getElementById("globeTooltip"),
  globeLegend: document.getElementById("globeLegend"),
  globeSection: document.getElementById("globeSection"),
  globeToggle: document.getElementById("globeToggle"),
  globeStage: document.getElementById("globeStage"),
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

// ---------- World map / Globe ----------
//
// Lightweight orthographic-projection globe rendered as SVG.
// No external dependencies — coordinates are embedded below, keyed by airport
// code so they stay in sync with regions.json. Country outlines are omitted
// intentionally (keeps the app offline-capable and zero-dependency); the
// graticule grid gives enough geographic context.

// Airport code -> [longitude, latitude] in degrees.
// Coordinates are approximate (city-level) and are only used to place a dot
// on a sphere; precise siting isn't needed.
const AIRPORT_COORDS = {
  AKL: [174.79, -36.85],  // Auckland
  ALE: [-104.07, 30.37],  // Alpine, TX
  APA: [-104.85, 39.57],  // Aurora / Denver, CO
  ARN: [17.92, 59.65],    // Stockholm
  BAH: [50.64, 26.27],    // Bahrain
  BJS: [116.60, 40.08],   // Beijing
  BKK: [100.75, 13.68],   // Bangkok
  BOM: [72.87, 19.09],    // Mumbai
  BPM: [78.48, 17.45],    // Hyderabad / Begumpet
  CDG: [2.55, 49.01],     // Paris
  CGK: [106.66, -6.13],   // Jakarta
  CMH: [-82.89, 39.99],   // Columbus, OH
  CPT: [18.60, -33.97],   // Cape Town
  DCA: [-77.46, 39.04],   // Ashburn, VA (IAD-area surrogate)
  DUB: [-6.27, 53.42],    // Dublin
  DXB: [55.36, 25.25],    // Dubai
  FFZ: [-111.73, 33.46],  // Phoenix / Mesa, AZ
  FRA: [8.57, 50.03],     // Frankfurt
  GRU: [-46.47, -23.43],  // São Paulo
  HKG: [113.93, 22.30],   // Hong Kong
  HYD: [78.43, 17.24],    // Hyderabad
  IAD: [-77.46, 38.95],   // Ashburn, VA
  ICN: [126.45, 37.46],   // Seoul / Incheon
  KIX: [135.23, 34.43],   // Osaka / Kansai
  KUL: [101.71, 2.74],    // Kuala Lumpur
  LCK: [-82.93, 39.81],   // Columbus / Rickenbacker, OH
  LHR: [-0.45, 51.47],    // London / Heathrow
  LTW: [-76.41, 39.32],   // Maryland
  LUX: [6.21, 49.63],     // Luxembourg
  MEL: [144.84, -37.67],  // Melbourne
  MXP: [8.72, 45.63],     // Milan / Malpensa
  NCL: [-1.69, 55.04],    // Newcastle
  NRT: [140.39, 35.77],   // Tokyo / Narita
  OSU: [-83.07, 40.08],   // Columbus / OSU, OH
  PDT: [-118.84, 45.70],  // Boardman/Pendleton, OR
  PDX: [-119.70, 45.84],  // Boardman, OR
  PEK: [116.60, 40.08],   // Beijing
  QRO: [-100.19, 20.62],  // Querétaro
  RUH: [46.70, 24.96],    // Riyadh
  SCL: [-70.79, -33.39],  // Santiago
  SDV: [34.78, 32.11],    // Tel Aviv / Sde Dov
  SEA: [-122.31, 47.45],  // Seattle
  SFO: [-121.89, 37.37],  // San Jose (region is N. California)
  SIN: [103.99, 1.36],    // Singapore
  SYD: [151.18, -33.94],  // Sydney
  THF: [13.40, 52.47],    // Berlin / Tempelhof
  TLV: [34.89, 32.01],    // Tel Aviv
  TPE: [121.23, 25.08],   // Taipei
  YUL: [-73.75, 45.47],   // Montreal
  YYC: [-114.02, 51.11],  // Calgary
  ZAZ: [-1.29, 41.67],    // Zaragoza
  ZHY: [106.25, 37.79],   // Zhongwei / Ningxia
  ZRH: [8.55, 47.46],     // Zurich
};

// Scope -> fill color. Mirrors the scope badge palette roughly.
const SCOPE_COLORS = {
  "commercial":         "#3fb950", // green  — always-on
  "commercial-optin":   "#58a6ff", // blue   — opt-in
  "govcloud":           "#a371f7", // purple
  "china":              "#f85149", // red    — distinct partition
  "iso":                "#d29922", // amber
  "sovereign":          "#ff9900", // AWS orange
  "retail":             "#8b949e", // grey   — internal
};

const SCOPE_LABELS = {
  "commercial":         "Commercial",
  "commercial-optin":   "Opt-in",
  "govcloud":           "GovCloud",
  "china":              "China",
  "iso":                "ISO",
  "sovereign":          "Sovereign",
  "retail":             "Retail",
};

const globe = {
  // Rotation in degrees: [lambda (lon), phi (lat)]. Positive lambda rotates west.
  rotation: [-20, -20],
  radius: 220,          // sphere radius in SVG viewport units (viewBox is 520x520)
  // Status-based dot size
  dotRadius: 4.2,
  draggedSinceMousedown: false,
  dragging: false,
  dragStart: null,      // { x, y, lambda, phi }
  hoveredRegion: null,
  worldRings: null,     // array of [[lon, lat], ...] rings, loaded async
};

const SVG_NS = "http://www.w3.org/2000/svg";

// Orthographic projection: project (lon, lat) on a sphere to 2D given
// current rotation. Returns { x, y, visible } where visible=false means
// the point is on the far side of the globe.
function project(lon, lat) {
  const lambda = (lon + globe.rotation[0]) * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  const phi0 = globe.rotation[1] * Math.PI / 180;

  const cosPhi = Math.cos(phi);
  const x = cosPhi * Math.sin(lambda);
  const y = Math.sin(phi) * Math.cos(phi0) - cosPhi * Math.cos(lambda) * Math.sin(phi0);
  // z > 0 means front-facing
  const z = Math.sin(phi) * Math.sin(phi0) + cosPhi * Math.cos(lambda) * Math.cos(phi0);

  return {
    x: x * globe.radius,
    y: -y * globe.radius,
    visible: z > 0,
  };
}

// Build a great-circle path (meridian or parallel) by sampling points.
// Returns an SVG path 'd' string. Splits the path into visible segments
// so backside arcs don't render.
function greatCirclePath(pointsLonLat) {
  let d = "";
  let inVisible = false;
  for (const [lon, lat] of pointsLonLat) {
    const p = project(lon, lat);
    if (p.visible) {
      d += (inVisible ? "L" : "M") + p.x.toFixed(2) + "," + p.y.toFixed(2) + " ";
      inVisible = true;
    } else {
      inVisible = false;
    }
  }
  return d.trim();
}

// Project and also return the sphere-space z coordinate (for horizon clipping).
function projectFull(lon, lat) {
  const lambda = (lon + globe.rotation[0]) * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  const phi0 = globe.rotation[1] * Math.PI / 180;

  const cosPhi = Math.cos(phi);
  const sx = cosPhi * Math.sin(lambda);
  const sy = Math.sin(phi) * Math.cos(phi0) - cosPhi * Math.cos(lambda) * Math.sin(phi0);
  const z = Math.sin(phi) * Math.sin(phi0) + cosPhi * Math.cos(lambda) * Math.cos(phi0);

  return { z, x: sx * globe.radius, y: -sy * globe.radius };
}

// Build an SVG path for a country ring with horizon clipping.
// Segments that cross the visible/hidden boundary are clipped at z = 0 so
// lines never cut across the sphere. Because we only stroke (no fill), we
// don't need to close the path along the horizon — broken subpaths are fine.
function countryRingPath(ring) {
  if (!ring || ring.length < 2) return "";
  const pts = ring.map(([lon, lat]) => projectFull(lon, lat));
  let d = "";
  let inSegment = false;
  const moveTo = (x, y) => { d += "M" + x.toFixed(2) + "," + y.toFixed(2) + " "; inSegment = true; };
  const lineTo = (x, y) => { d += "L" + x.toFixed(2) + "," + y.toFixed(2) + " "; };
  const intersect = (a, b) => {
    const t = a.z / (a.z - b.z);
    return [a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)];
  };

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const av = a.z >= 0;
    const bv = b.z >= 0;

    if (av && bv) {
      if (!inSegment) moveTo(a.x, a.y);
      lineTo(b.x, b.y);
    } else if (av && !bv) {
      if (!inSegment) moveTo(a.x, a.y);
      const [cx, cy] = intersect(a, b);
      lineTo(cx, cy);
      inSegment = false;
    } else if (!av && bv) {
      const [cx, cy] = intersect(a, b);
      moveTo(cx, cy);
      lineTo(b.x, b.y);
    } else {
      inSegment = false;
    }
  }
  return d.trim();
}

function buildGraticule() {
  const paths = [];
  // Meridians every 30°
  for (let lon = -180; lon < 180; lon += 30) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 5) pts.push([lon, lat]);
    paths.push({ d: greatCirclePath(pts), equator: false });
  }
  // Parallels every 30°
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 5) pts.push([lon, lat]);
    paths.push({ d: greatCirclePath(pts), equator: lat === 0 });
  }
  // Explicit equator
  const eq = [];
  for (let lon = -180; lon <= 180; lon += 5) eq.push([lon, 0]);
  paths.push({ d: greatCirclePath(eq), equator: true });
  return paths;
}

function renderGlobe() {
  if (!els.globeSvg) return;
  const svg = els.globeSvg;
  // Clear
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Sphere
  const sphere = document.createElementNS(SVG_NS, "circle");
  sphere.setAttribute("class", "globe-sphere");
  sphere.setAttribute("cx", "0");
  sphere.setAttribute("cy", "0");
  sphere.setAttribute("r", String(globe.radius));
  svg.appendChild(sphere);

  // Graticule
  const graticuleGroup = document.createElementNS(SVG_NS, "g");
  for (const g of buildGraticule()) {
    if (!g.d) continue;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", g.equator ? "globe-graticule globe-equator" : "globe-graticule");
    path.setAttribute("d", g.d);
    graticuleGroup.appendChild(path);
  }
  svg.appendChild(graticuleGroup);

  // Country outlines
  if (globe.worldRings) {
    const landGroup = document.createElementNS(SVG_NS, "g");
    landGroup.setAttribute("class", "globe-land");
    for (const ring of globe.worldRings) {
      const d = countryRingPath(ring);
      if (!d) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "globe-country");
      path.setAttribute("d", d);
      landGroup.appendChild(path);
    }
    svg.appendChild(landGroup);
  }

  // Region dots
  const dotsGroup = document.createElementNS(SVG_NS, "g");
  const backGroup = document.createElementNS(SVG_NS, "g");
  const frontGroup = document.createElementNS(SVG_NS, "g");
  backGroup.setAttribute("class", "globe-dots-back");
  frontGroup.setAttribute("class", "globe-dots-front");

  const currentQuery = (els.search?.value || "").trim();
  const activeCodes = new Set(
    currentQuery ? search(currentQuery).map((r) => r.regionCode) : []
  );

  for (const region of state.regions) {
    const coords = AIRPORT_COORDS[region.airport];
    if (!coords) continue;
    const [lon, lat] = coords;
    const p = project(lon, lat);

    const dot = document.createElementNS(SVG_NS, "circle");
    const isBuild = region.status === "BUILD";
    const isActive = activeCodes.has(region.regionCode);
    dot.setAttribute("cx", p.x.toFixed(2));
    dot.setAttribute("cy", p.y.toFixed(2));
    dot.setAttribute("r", String(isActive ? globe.dotRadius + 2 : globe.dotRadius));
    dot.setAttribute("fill", SCOPE_COLORS[region.scope] || "#8b949e");
    dot.setAttribute("stroke", "#0a1320");
    dot.setAttribute("stroke-width", "1");
    dot.setAttribute("data-region", region.regionCode);
    let cls = "globe-dot";
    if (!p.visible) cls += " back";
    if (isActive) cls += " active";
    if (isBuild) dot.setAttribute("opacity", "0.75");
    dot.setAttribute("class", cls);
    (p.visible ? frontGroup : backGroup).appendChild(dot);
  }

  svg.appendChild(backGroup);
  svg.appendChild(dotsGroup);
  svg.appendChild(frontGroup);
}

function renderGlobeLegend() {
  if (!els.globeLegend) return;
  const scopesInUse = new Set(state.regions.map((r) => r.scope).filter(Boolean));
  const order = ["commercial", "commercial-optin", "govcloud", "china", "iso", "sovereign", "retail"];
  const items = order
    .filter((s) => scopesInUse.has(s))
    .map((s) => `
      <span class="globe-legend-item">
        <span class="globe-legend-swatch" style="background:${SCOPE_COLORS[s]}"></span>
        ${escapeHtml(SCOPE_LABELS[s] || s)}
      </span>
    `).join("");
  els.globeLegend.innerHTML = items;
}

function showGlobeTooltip(region, clientX, clientY) {
  if (!els.globeTooltip || !els.globeStage) return;
  const stageRect = els.globeStage.getBoundingClientRect();
  const x = clientX - stageRect.left;
  const y = clientY - stageRect.top;
  const live = state.liveData?.get(region.regionCode);
  const sub = [
    region.city && region.country ? `${region.city}, ${region.country}` : region.city || region.country,
    live ? `${live.serviceCount} services` : null,
    region.status && region.status !== "GA" ? region.status : null,
  ].filter(Boolean).join(" · ");
  els.globeTooltip.innerHTML = `
    <strong>${escapeHtml(region.airport)}</strong> ${escapeHtml(region.regionCode)}
    <span class="tt-sub">${escapeHtml(region.longName || "")}</span>
    ${sub ? `<span class="tt-sub">${escapeHtml(sub)}</span>` : ""}
  `;
  els.globeTooltip.style.left = x + "px";
  els.globeTooltip.style.top = y + "px";
  els.globeTooltip.classList.remove("hidden");
}

function hideGlobeTooltip() {
  if (els.globeTooltip) els.globeTooltip.classList.add("hidden");
}

function initGlobe() {
  if (!els.globeSvg) return;
  renderGlobeLegend();
  renderGlobe();

  // Restore collapsed state from cookie / localStorage
  applyGlobeCollapsedFromStorage();

  // Load country outlines in the background — globe renders without them first,
  // then re-renders once the data arrives.
  fetch("world-110m.json")
    .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
    .then((data) => {
      globe.worldRings = data.rings || [];
      renderGlobe();
    })
    .catch((err) => {
      console.warn("Could not load world map outlines:", err);
      // Non-fatal — globe still works with dots + graticule only.
    });

  // Drag to rotate (mouse + touch via pointer events)
  const onPointerDown = (e) => {
    globe.dragging = true;
    globe.draggedSinceMousedown = false;
    globe.dragStart = {
      x: e.clientX,
      y: e.clientY,
      lambda: globe.rotation[0],
      phi: globe.rotation[1],
    };
    els.globeSvg.classList.add("dragging");
    els.globeSvg.setPointerCapture?.(e.pointerId);
    hideGlobeTooltip();
  };

  const onPointerMove = (e) => {
    // Hover handling (not dragging)
    if (!globe.dragging) {
      const target = e.target.closest?.("[data-region]");
      if (target) {
        const code = target.getAttribute("data-region");
        const region = state.regions.find((r) => r.regionCode === code);
        if (region) {
          if (globe.hoveredRegion !== code) {
            globe.hoveredRegion = code;
          }
          showGlobeTooltip(region, e.clientX, e.clientY);
          return;
        }
      }
      if (globe.hoveredRegion) {
        globe.hoveredRegion = null;
        hideGlobeTooltip();
      }
      return;
    }

    // Drag rotation
    const dx = e.clientX - globe.dragStart.x;
    const dy = e.clientY - globe.dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) globe.draggedSinceMousedown = true;
    // Rotation sensitivity scales inversely with zoom. At the default radius
    // of 220, k ≈ 0.4 (1 pixel ≈ 0.4°). Zoom in and we turn more slowly so the
    // globe doesn't whip past the area you're trying to look at.
    const k = 0.4 * (220 / globe.radius);
    globe.rotation[0] = globe.dragStart.lambda + dx * k;
    // Clamp latitude to avoid flipping
    globe.rotation[1] = Math.max(-89, Math.min(89, globe.dragStart.phi + dy * k));
    renderGlobe();
  };

  const onPointerUp = (e) => {
    if (!globe.dragging) return;
    globe.dragging = false;
    els.globeSvg.classList.remove("dragging");
    els.globeSvg.releasePointerCapture?.(e.pointerId);

    // Treat as click if the pointer barely moved
    if (!globe.draggedSinceMousedown) {
      const target = e.target.closest?.("[data-region]");
      if (target) {
        const code = target.getAttribute("data-region");
        // Filter the region list to just this region by searching by its code
        els.search.value = code;
        render();
        renderGlobe();
        // Scroll the matching card into view
        setTimeout(() => {
          els.results.querySelector(".region-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 50);
      }
    }
  };

  els.globeSvg.addEventListener("pointerdown", onPointerDown);
  els.globeSvg.addEventListener("pointermove", onPointerMove);
  els.globeSvg.addEventListener("pointerup", onPointerUp);
  els.globeSvg.addEventListener("pointerleave", () => {
    if (!globe.dragging) hideGlobeTooltip();
  });

  // Wheel to zoom (adjust sphere radius within a sane range)
  els.globeSvg.addEventListener("wheel", (e) => {
    e.preventDefault();
    // Multiplicative zoom so high zoom levels still feel responsive
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    globe.radius = Math.max(120, Math.min(4000, globe.radius * factor));
    renderGlobe();
  }, { passive: false });

  // Collapse/expand toggle
  els.globeToggle?.addEventListener("click", () => {
    const collapsed = els.globeSection.classList.toggle("collapsed");
    els.globeToggle.textContent = collapsed ? "Show" : "Hide";
    els.globeToggle.setAttribute("aria-expanded", String(!collapsed));
    persistGlobeCollapsed(collapsed);
    if (!collapsed) renderGlobe();
  });
}

// Persist the "Hide"/"Show" state so the user's preference survives reloads.
const GLOBE_COLLAPSED_KEY = "regionator_globe_collapsed";
const GLOBE_COLLAPSED_MAX_AGE_DAYS = 365;

function applyGlobeCollapsedFromStorage() {
  let collapsed = false;
  if (getCookie(GLOBE_COLLAPSED_KEY) === "1") {
    collapsed = true;
  } else {
    try {
      if (window.localStorage.getItem(GLOBE_COLLAPSED_KEY) === "1") collapsed = true;
    } catch (_) { /* ignore */ }
  }
  if (!collapsed) return;
  els.globeSection.classList.add("collapsed");
  if (els.globeToggle) {
    els.globeToggle.textContent = "Show";
    els.globeToggle.setAttribute("aria-expanded", "false");
  }
}

function persistGlobeCollapsed(collapsed) {
  const value = collapsed ? "1" : "0";
  setCookie(GLOBE_COLLAPSED_KEY, value, GLOBE_COLLAPSED_MAX_AGE_DAYS);
  try { window.localStorage.setItem(GLOBE_COLLAPSED_KEY, value); } catch (_) { /* ignore */ }
}

// ---------- Events ----------
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

els.search.addEventListener("input", () => {
  render();
  renderGlobe();
});
els.refreshBtn.addEventListener("click", async () => {
  await loadLiveData();
  render();
  renderGlobe();
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
    initGlobe();
  } catch (err) {
    els.results.innerHTML = `<div class="live-status visible error">Failed to load regions.json: ${escapeHtml(err.message)}</div>`;
    return;
  }

  // Fetch live data in the background — don't block first render.
  loadLiveData({ silent: false }).then(() => {
    render();
    renderGlobe();
  });
})();
