// NetworkMonitor.ts — v0.5.0
// ─── EWMA ─────────────────────────────────────────────────────────────────────
const ALPHA = 0.15;
const MIN_SAMPLES = 4;
class EWMABaseline {
    ewma = null;
    count = 0;
    update(value) {
        this.count++;
        this.ewma = this.ewma === null
            ? value
            : ALPHA * value + (1 - ALPHA) * this.ewma;
    }
    /** null si pas encore assez d'échantillons */
    getBaseline() {
        if (this.ewma === null || this.count < MIN_SAMPLES)
            return null;
        const correction = 1 - Math.pow(1 - ALPHA, this.count);
        return this.ewma / correction;
    }
    reset() {
        this.ewma = null;
        this.count = 0;
    }
}
// ─── Constantes ───────────────────────────────────────────────────────────────
const DEFAULT_PING_INTERVAL_MS = 5_000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;
const DEFAULT_DOWNLINK_RESAMPLE = 6; // 1 GET pour 5 HEAD
// 4 pings rapides au démarrage pour établir une baseline réelle en ~2s
const WARMUP_COUNT = 4;
const WARMUP_INTERVAL_MS = 500;
const DEFAULT_THRESHOLDS = {
    absoluteGood: 2,
    absolutePoor: 0.15,
    ratioGood: 0.75,
    ratioDegraded: 0.35,
    maxLatency: 400,
};
// ─── NetworkMonitor ───────────────────────────────────────────────────────────
export class NetworkMonitor {
    currentInfo = {
        state: "offline",
        latency: Infinity,
        downlink: 0,
        rtt: 0,
    };
    firstEvaluationDone = false;
    isRunning = false;
    warmupDone = false;
    // [Fix 1] Guard anti race-condition
    isEvaluating = false;
    evaluateDebounceTimer = null;
    evaluationController = null;
    // [Fix 2] État du probe HEAD/GET hybride
    probeCount = 0;
    lastKnownDownlink = null;
    downlinkResampleEvery;
    listeners = new Set();
    pingInterval = null;
    baseline = new EWMABaseline();
    thresholds;
    loggingEnabled;
    pingUrl;
    pingIntervalMs;
    pingTimeoutMs;
    // [Fix 1] Tous les handlers passent par scheduleEvaluate()
    onlineHandler = () => this.scheduleEvaluate();
    offlineHandler = () => this.scheduleEvaluate();
    connectionChangeHandler = () => this.scheduleEvaluate();
    constructor(options = {}) {
        this.pingUrl = options.pingUrl ?? "";
        this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        this.pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
        this.loggingEnabled = options.logging ?? false;
        this.downlinkResampleEvery = options.downlinkResampleEvery ?? DEFAULT_DOWNLINK_RESAMPLE;
        if (!this.hasConnectionAPI && !this.pingUrl) {
            console.warn("[netfixer] navigator.connection n'est pas disponible sur ce navigateur " +
                "(Firefox, Safari). Sans pingUrl, l'état réseau démarrera en « poor » " +
                "par sécurité jusqu'à ce qu'une mesure réelle soit possible. " +
                "Configurez pingUrl pour une détection fiable.");
        }
    }
    // ─── API publique ─────────────────────────────────────────────────────────
    start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        window.addEventListener("online", this.onlineHandler);
        window.addEventListener("offline", this.offlineHandler);
        const nav = navigator;
        nav.connection?.addEventListener?.("change", this.connectionChangeHandler);
        if (this.pingUrl) {
            void this.runWarmup().then(() => {
                this.warmupDone = true;
                this.pingInterval = setInterval(() => { void this.evaluate(); }, this.pingIntervalMs);
            });
        }
        else {
            this.warmupDone = true;
            void this.evaluate();
        }
    }
    stop() {
        if (!this.isRunning)
            return;
        this.isRunning = false;
        // [Fix 1] Nettoie aussi le debounce timer
        if (this.evaluateDebounceTimer !== null) {
            clearTimeout(this.evaluateDebounceTimer);
            this.evaluateDebounceTimer = null;
        }
        this.evaluationController?.abort();
        this.evaluationController = null;
        if (this.pingInterval !== null) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        window.removeEventListener("online", this.onlineHandler);
        window.removeEventListener("offline", this.offlineHandler);
        const nav = navigator;
        nav.connection?.removeEventListener?.("change", this.connectionChangeHandler);
    }
    onChange(listener) {
        this.listeners.add(listener);
        if (this.firstEvaluationDone) {
            listener(this.currentInfo);
        }
        return () => { this.listeners.delete(listener); };
    }
    getState() { return this.currentInfo.state; }
    getInfo() { return { ...this.currentInfo }; }
    // ─── Fix 1 — Debounce pour absorber les rafales d'events simultanés ───────
    /**
     * Point d'entrée unique pour tous les handlers d'événements.
     * Absorbe les rafales (online + connection change simultanés) via un debounce 50ms.
     */
    scheduleEvaluate() {
        if (this.evaluateDebounceTimer !== null) {
            clearTimeout(this.evaluateDebounceTimer);
        }
        this.evaluateDebounceTimer = setTimeout(() => {
            this.evaluateDebounceTimer = null;
            void this.evaluate();
        }, 50);
    }
    // ─── Warmup ───────────────────────────────────────────────────────────────
    async runWarmup() {
        for (let i = 0; i < WARMUP_COUNT; i++) {
            if (!this.isRunning)
                return;
            await this.evaluate();
            if (i < WARMUP_COUNT - 1) {
                await this.wait(WARMUP_INTERVAL_MS);
            }
        }
    }
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    // ─── Évaluation ───────────────────────────────────────────────────────────
    /**
     * [Fix 1] Guard isEvaluating : empêche les évaluations concurrentes
     * même si les AbortControllers annulent les requêtes fetch en vol.
     */
    async evaluate() {
        if (this.isEvaluating) {
            this.log("[evaluate] déjà en cours — ignoré");
            return;
        }
        this.isEvaluating = true;
        this.evaluationController?.abort();
        const controller = new AbortController();
        this.evaluationController = controller;
        try {
            if (!navigator.onLine) {
                this.notify({ state: "offline", latency: Infinity, downlink: 0, rtt: 0 }, controller);
                return;
            }
            const nav = navigator;
            // Cas 1 — navigator.connection disponible + pas de ping configuré
            if (this.hasConnectionAPI && !this.pingUrl) {
                // [Fix 3] try/catch + vérification isFinite sur chaque valeur
                try {
                    const conn = nav.connection;
                    const downlink = typeof conn?.downlink === "number" && isFinite(conn.downlink)
                        ? conn.downlink : 10;
                    const latency = typeof conn?.rtt === "number" && isFinite(conn.rtt)
                        ? conn.rtt : 0;
                    const state = this.computeState(latency, downlink);
                    this.notify({ state, latency, downlink, rtt: latency }, controller);
                }
                catch {
                    // API instable sur navigateur exotique → défensif
                    this.notify({ state: "poor", latency: Infinity, downlink: 0, rtt: 0 }, controller);
                }
                return;
            }
            // Cas 2 — ping configuré (tous navigateurs)
            if (this.pingUrl) {
                const { latency, downlink } = await this.probe(controller.signal);
                if (controller.signal.aborted)
                    return;
                const rtt = (() => {
                    try {
                        const conn = nav.connection;
                        return typeof conn?.rtt === "number" && isFinite(conn.rtt)
                            ? conn.rtt : latency;
                    }
                    catch {
                        return latency;
                    }
                })();
                const state = this.computeState(latency, downlink);
                this.notify({ state, latency, downlink, rtt }, controller);
                return;
            }
            // Cas 3 — pas de navigator.connection ET pas de ping
            this.notify({ state: "poor", latency: Infinity, downlink: 0, rtt: 0 }, controller);
        }
        catch (error) {
            if (error instanceof DOMException && error.name === "AbortError")
                return;
            this.log(`[evaluate] erreur inattendue — ${String(error)}`);
        }
        finally {
            // [Fix 1] Libère toujours le verrou
            this.isEvaluating = false;
            if (this.evaluationController === controller) {
                this.evaluationController = null;
            }
        }
    }
    // ─── Fix 2 — Probe HEAD/GET hybride ──────────────────────────────────────
    /**
     * Mesure la latence via HEAD (léger, ~0 octet) à chaque ping.
     * Tous les N pings (downlinkResampleEvery), fait un GET complet pour
     * recalibrer le débit réel. Utilise Resource Timing API si disponible
     * pour une mesure plus précise que le calcul maison.
     *
     * Économie : avec N=6 et interval=5s, ~1 GET pour 5 HEAD
     * soit ~83% de data économisée vs toujours faire un GET.
     */
    async probe(signal) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.pingTimeoutMs);
        signal.addEventListener("abort", () => controller.abort(), { once: true });
        const url = new URL(this.pingUrl, window.location.origin);
        url.searchParams.set("t", Date.now().toString());
        const needsDownlink = (this.probeCount % this.downlinkResampleEvery) === 0;
        this.probeCount++;
        const start = performance.now();
        try {
            if (!needsDownlink) {
                // HEAD : latence seule, aucun body téléchargé
                await fetch(url.toString(), {
                    method: "HEAD",
                    cache: "no-store",
                    signal: controller.signal,
                });
                const latency = Math.round(performance.now() - start);
                this.log(`[probe:HEAD] latency=${latency}ms — downlink réutilisé: ${this.lastKnownDownlink ?? 0} Mbps`);
                return { latency, downlink: this.lastKnownDownlink ?? 0 };
            }
            // GET complet pour mesurer le débit
            const response = await fetch(url.toString(), {
                method: "GET",
                cache: "no-store",
                signal: controller.signal,
            });
            const ttfb = Math.round(performance.now() - start);
            const buffer = await response.arrayBuffer();
            const bytes = buffer.byteLength;
            // Préfère Resource Timing API (plus précis que le calcul maison)
            let downlink = 0;
            try {
                const entries = performance.getEntriesByType("resource");
                const entry = entries.findLast(e => e.name.startsWith(url.origin + url.pathname));
                if (entry && entry.transferSize > 0) {
                    const transferMs = entry.responseEnd - entry.requestStart;
                    downlink = transferMs > 0
                        ? parseFloat(((entry.transferSize * 8) / (transferMs * 1000)).toFixed(2))
                        : 0;
                    this.log(`[probe:GET:ResourceTiming] ttfb=${ttfb}ms — downlink=${downlink}Mbps`);
                }
            }
            catch {
                // Resource Timing non disponible ou bloqué par Timing-Allow-Origin
            }
            // Fallback calcul maison si Resource Timing n'a rien donné
            if (downlink === 0) {
                const totalMs = performance.now() - start;
                const transfer = totalMs - ttfb;
                downlink = transfer > 0 && bytes > 0
                    ? parseFloat(((bytes * 8) / (transfer * 1000)).toFixed(2))
                    : 0;
                this.log(`[probe:GET:fallback] ttfb=${ttfb}ms — downlink=${downlink}Mbps`);
            }
            this.lastKnownDownlink = downlink;
            return { latency: ttfb, downlink };
        }
        catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                return { latency: Infinity, downlink: 0 };
            }
            // [Fix 4] Log structuré par type d'erreur réseau
            if (error instanceof TypeError) {
                this.log("[probe] erreur réseau (CORS ou DNS) — " + String(error));
            }
            else {
                this.log("[probe] erreur inconnue — " + String(error));
            }
            return { latency: Infinity, downlink: 0 };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    // ─── Calcul d'état — sans side-effect ─────────────────────────────────────
    computeState(latency, downlink) {
        if (!Number.isFinite(latency))
            return "poor";
        if (downlink > this.thresholds.absoluteGood && latency < this.thresholds.maxLatency) {
            return "good";
        }
        if (downlink < this.thresholds.absolutePoor)
            return "poor";
        this.baseline.update(downlink);
        const base = this.baseline.getBaseline();
        if (base === null || base === 0) {
            return this.computeFromEffectiveType(latency);
        }
        const ratio = downlink / base;
        if (ratio > this.thresholds.ratioGood && latency < this.thresholds.maxLatency)
            return "good";
        if (ratio > this.thresholds.ratioDegraded)
            return "degraded";
        return "poor";
    }
    computeFromEffectiveType(latency) {
        // [Fix 3] try/catch au cas où l'accès à connection plante
        try {
            const nav = navigator;
            const type = nav.connection?.effectiveType;
            if (type === "4g" && latency < this.thresholds.maxLatency)
                return "good";
            if (type === "3g")
                return "degraded";
            if (type === "2g" || type === "slow-2g")
                return "poor";
            const downlink = (() => {
                const d = nav.connection?.downlink;
                return typeof d === "number" && isFinite(d) ? d : 0;
            })();
            if (downlink > this.thresholds.absoluteGood && latency < this.thresholds.maxLatency)
                return "good";
            if (downlink > this.thresholds.absolutePoor)
                return "degraded";
        }
        catch {
            this.log("[computeFromEffectiveType] navigator.connection inaccessible");
        }
        return "poor";
    }
    // ─── Notification ─────────────────────────────────────────────────────────
    notify(info, controller) {
        if (controller.signal.aborted)
            return;
        const changed = info.state !== this.currentInfo.state ||
            info.latency !== this.currentInfo.latency ||
            info.downlink !== this.currentInfo.downlink ||
            info.rtt !== this.currentInfo.rtt;
        if (!changed && this.firstEvaluationDone)
            return;
        this.currentInfo = info;
        this.firstEvaluationDone = true;
        for (const listener of this.listeners) {
            try {
                listener(info);
            }
            catch (error) {
                console.error("[netfixer] erreur dans un listener :", error);
            }
        }
    }
    // ─── Utils ────────────────────────────────────────────────────────────────
    get hasConnectionAPI() {
        return "connection" in navigator;
    }
    log(message) {
        if (this.loggingEnabled) {
            console.log(`[netfixer] ${message}`);
        }
    }
}
//# sourceMappingURL=NetworkMonitor.js.map