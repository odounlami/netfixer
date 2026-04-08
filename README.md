# netfixer

**Make `fetch` resilient on bad networks.**

Most retry libraries ask one question: *did the request fail?*  
Netfixer asks a different one: *should this request go out at all right now?*

It monitors connection quality in real time — latency, throughput, not just `navigator.onLine` — and decides **when** requests should be sent, **which** ones go first, and **how** to retry them safely.

```ts
// Without netfixer: send and hope
const res = await fetch("/api/data");

// With netfixer: network-aware, prioritized, retried automatically
const res = await scheduler.fetch("/api/data", { netPriority: "normal" });
```

---

## Why netfixer?

`navigator.onLine` lies. A phone on a congested 2G tower is technically "online". A laptop on a flaky hotel Wi-Fi is technically "online". Your requests time out anyway.

Netfixer measures actual latency and throughput, classifies the connection into `good / degraded / poor / offline`, and routes your requests accordingly — holding background traffic when things are struggling, letting critical requests through regardless, and retrying everything with proper backoff when things recover.

---

## Features

- 📶 Real-time network quality — `good`, `degraded`, `poor`, `offline`
- 🚦 Priority-based scheduling — `critical`, `normal`, `background`
- 🔁 Automatic retry with exponential backoff + jitter
- 💾 Optional queue persistence across page reloads (`localStorage` / `sessionStorage`)
- ⏱ Per-request and global timeout
- 🕒 Max queue age — force-send after a configurable wait
- 🌍 Cross-browser — works without `navigator.connection` (Firefox, Safari)
- 🧠 HEAD/GET hybrid probing — ~83% less bandwidth than polling with GET

---

## Installation

```bash
npm install netfixer
```

---

## Quick start

```ts
import { NetworkMonitor, RequestScheduler } from "netfixer";

const monitor = new NetworkMonitor({ pingUrl: "/ping" });
monitor.start();

const scheduler = new RequestScheduler({ monitor });

const res = await scheduler.fetch("/api/data");
const data = await res.json();
```

---

## How it works

Netfixer has two parts.

### NetworkMonitor

Probes your connection every few seconds using lightweight `HEAD` requests (with occasional `GET` for throughput recalibration). Classifies the connection into one of four states:

| State | Meaning |
|---|---|
| `good` | Low latency, normal throughput |
| `degraded` | Slower than usual, still usable |
| `poor` | Very slow or unreliable |
| `offline` | No connectivity |

### RequestScheduler

Wraps `fetch()` with priority, queueing, and retry. Each request declares its priority. The scheduler checks the current network state and decides: send now, queue for later, or force-send after a timeout.

Default rules:

| Network state | Allowed priorities |
|---|---|
| `good` | `critical`, `normal`, `background` |
| `degraded` | `critical`, `normal` |
| `poor` | `critical` |
| `offline` | *(nothing sent)* |

Queued requests flush in **priority order** (critical first), then **FIFO** within the same tier.

---

## Examples

### Payment, auth, checkout — must go through

```ts
await scheduler.fetch("/api/checkout", {
  method: "POST",
  body: JSON.stringify(order),
  headers: { "Content-Type": "application/json" },
  netPriority: "critical",
});
```

Sent even on a poor connection. Retried up to 3 times on failure.

### Dashboard, feed, profile — user-facing

```ts
await scheduler.fetch("/api/dashboard", {
  netPriority: "normal",
  timeoutMs: 5_000,
});
```

Sent on `good` or `degraded`. Queued silently on `poor` or `offline`.

### Analytics, telemetry — eventually

```ts
await scheduler.fetch("/api/events", {
  method: "POST",
  body: JSON.stringify(event),
  headers: { "Content-Type": "application/json" },
  netPriority: "background",
  persist: true,
  maxQueueAgeMs: 30_000,
});
```

Sent only on a good connection. Persists across page reloads. Force-sent after 30 seconds regardless of network state.

---

## API

### `NetworkMonitor`

```ts
new NetworkMonitor(options?)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `pingUrl` | `string` | `""` | URL for active probing. Required for reliable detection on Firefox and Safari. |
| `pingIntervalMs` | `number` | `5000` | Interval between probes in ms. |
| `pingTimeoutMs` | `number` | `5000` | Per-probe timeout in ms. |
| `thresholds` | `Partial<NetworkThresholds>` | See below | Custom classification thresholds. |
| `downlinkResampleEvery` | `number` | `6` | Number of HEAD probes before a full GET throughput recalibration. |
| `logging` | `boolean` | `false` | Enable debug logs. |

**Default thresholds:**

```ts
{
  absoluteGood:  2,    // Mbps — always "good" above this
  absolutePoor:  0.15, // Mbps — always "poor" below this
  ratioGood:     0.75, // ratio to EWMA baseline → "good"
  ratioDegraded: 0.35, // ratio to EWMA baseline → "degraded"
  maxLatency:    400,  // ms — ceiling for "good"
}
```

**Methods:**

```ts
monitor.start()                    // Start monitoring
monitor.stop()                     // Stop and clean up
monitor.getState()                 // => NetworkState
monitor.getInfo()                  // => { state, latency, downlink, rtt }
monitor.onChange(fn)               // Subscribe; returns unsubscribe()
```

```ts
monitor.onChange(({ state, latency, downlink }) => {
  console.log(`${state} — ${latency}ms — ${downlink} Mbps`);
});
```

---

### `RequestScheduler`

```ts
new RequestScheduler(options)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `monitor` | `NetworkMonitor` | *(required)* | Monitor instance. |
| `rules` | `Partial<PriorityRules>` | See defaults | Override allowed priorities per state. |
| `initialBackoffMs` | `number` | `1000` | Initial backoff delay. |
| `maxBackoffMs` | `number` | `30000` | Maximum backoff delay. |
| `defaultTimeoutMs` | `number` | `10000` | Default per-request timeout. |
| `retryableStatuses` | `number[]` | `[429, 500, 502, 503, 504]` | HTTP statuses that trigger a retry. |
| `persist` | `boolean` | `false` | Persist queued requests across reloads. |
| `maxQueueAgeMs` | `number \| null` | `null` | Global max queue wait before force-send. |
| `logging` | `boolean` | `false` | Enable debug logs. |

**Per-request options** (all `RequestInit` options plus):

| Option | Type | Default | Description |
|---|---|---|---|
| `netPriority` | `"critical" \| "normal" \| "background"` | `"normal"` | Priority tier. |
| `timeoutMs` | `number` | scheduler default | Timeout for this request. |
| `persist` | `boolean` | scheduler default | Persist this request across reloads. |
| `maxQueueAgeMs` | `number` | scheduler default | Max queue wait for this request. |

**Methods:**

```ts
scheduler.fetch(url, init?)   // => Promise<Response>
scheduler.destroy()           // Stop timers, reject queued requests, clean up
```

---

## Retry behavior

Requests are retried on network errors, timeouts, and configured HTTP statuses.

```
delay = min(initialBackoffMs × 2^retries, maxBackoffMs) + jitter(±20%)
```

Defaults: **3 max retries** — 1s → 2s → 4s (with jitter), capped at 30s.

---

## Queue persistence

With `persist: true`, queued requests survive page reloads. On next load they are restored and sent when the network allows.

Storage strategy: `localStorage` first, `sessionStorage` as fallback. Non-serializable bodies (`ReadableStream`, `FormData`, `Blob`, `ArrayBuffer`) are automatically excluded with a warning.

> **Note:** the original `Promise` is lost on reload. Persisted requests are fire-and-forget — they will be sent, but no caller receives the response. This is intentional.

---

## Custom rules

```ts
const scheduler = new RequestScheduler({
  monitor,
  rules: {
    degraded: ["critical"],        // only critical on degraded
    poor: ["critical", "normal"],  // allow normal on poor
  },
});
```

---

## Browser compatibility

`navigator.connection` is unavailable in Firefox and Safari. Without `pingUrl`, these browsers default to `poor` until a real measurement is available.

**Always configure `pingUrl` for reliable cross-browser behavior.**

---

## ⚠️ Retry safety

Netfixer may send a request more than once — on retry, timeout, or after a reload. **Your backend should handle duplicate requests safely.**

For mutating endpoints (`POST`, `PUT`, `DELETE`), use idempotency keys or duplicate-safe logic server-side. Netfixer improves client-side reliability — it does not guarantee exactly-once delivery.

---

## Lifecycle

```ts
monitor.stop();
scheduler.destroy();
```

Call this on SPA teardown, route unmount, or test cleanup. `destroy()` clears all timers, unsubscribes from the monitor, and rejects any queued requests immediately.

---

## TypeScript

Netfixer is written in TypeScript and ships full type declarations.

```ts
type NetworkState    = "good" | "degraded" | "poor" | "offline";
type RequestPriority = "critical" | "normal" | "background";

interface NetworkInfo {
  state:    NetworkState;
  latency:  number; // ms
  downlink: number; // Mbps
  rtt:      number; // ms
}

interface SchedulerRequestInit extends RequestInit {
  netPriority?:   RequestPriority;
  timeoutMs?:     number;
  persist?:       boolean;
  maxQueueAgeMs?: number;
}
```

---

## When to use netfixer

Good fit for apps that need:

- resilient requests on flaky mobile networks
- priority traffic (critical goes first, background waits)
- automatic retry without boilerplate
- background events or analytics that must eventually land
- queue persistence across reloads

---

## When not to use netfixer

Netfixer is a **smart request layer**, not a full offline platform. It is not a replacement for:

- Service Workers + Background Sync API
- IndexedDB-based sync engines
- Conflict resolution or data reconciliation systems

If you need guaranteed delivery with conflict handling, look at those instead.

---

## Publishing to npm

> Run these commands from the root of your project.

**1. Make sure you're logged in:**

```bash
npm login
```

**2. Build your TypeScript:**

```bash
tsc
```

**3. Check what will be published:**

```bash
npm pack --dry-run
```

Make sure only `dist/`, `README.md`, and `LICENSE` are included. If needed, add a `.npmignore` or verify the `files` field in your `package.json`:

```json
{
  "files": ["dist", "README.md", "LICENSE"]
}
```

**4. Publish:**

```bash
npm publish --access public
```

**5. For subsequent releases**, bump the version first:

```bash
npm version patch   # 0.5.0 → 0.5.1  (bug fix)
npm version minor   # 0.5.0 → 0.6.0  (new feature)
npm version major   # 0.5.0 → 1.0.0  (breaking change)

npm publish --access public
```

---

## License

MIT
