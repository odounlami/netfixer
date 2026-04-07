// NetworkMonitor.ts — v0.4.0
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
    evaluationController = null;
    listeners = new Set();
    pingInterval = null;
    baseline = new EWMABaseline();
    thresholds;
    pingUrl;
    pingIntervalMs;
    pingTimeoutMs;
    onlineHandler = () => { void this.evaluate(); };
    offlineHandler = () => { void this.evaluate(); };
    connectionChangeHandler = () => { void this.evaluate(); };
    constructor(options = {}) {
        this.pingUrl = options.pingUrl ?? "";
        this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
        this.pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
        // Avertit si le navigateur ne supporte pas navigator.connection et qu'aucun
        // ping n'est configuré — la détection sera inexacte sur Firefox et Safari
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
            // Warmup : 4 pings rapides pour avoir une baseline réelle en ~2s
            // sur tous les navigateurs, y compris Firefox et Safari
            void this.runWarmup().then(() => {
                this.warmupDone = true;
                // Intervalle normal après le warmup
                this.pingInterval = setInterval(() => { void this.evaluate(); }, this.pingIntervalMs);
            });
        }
        else {
            // Pas de ping configuré
            this.warmupDone = true;
            void this.evaluate();
        }
    }
    stop() {
        if (!this.isRunning)
            return;
        this.isRunning = false;
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
    // ─── Warmup ───────────────────────────────────────────────────────────────
    /**
     * Lance WARMUP_COUNT pings rapides espacés de WARMUP_INTERVAL_MS.
     * Permet d'établir une baseline EWMA fiable en ~2s au lieu d'attendre
     * le premier intervalle normal (5s par défaut).
     */
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
    async evaluate() {
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
            // → comportement identique à v0.3, rien ne change pour Chrome/Edge
            if (this.hasConnectionAPI && !this.pingUrl) {
                const downlink = nav.connection?.downlink ?? 10;
                const latency = nav.connection?.rtt ?? 0;
                const rtt = latency;
                const state = this.computeState(latency, downlink);
                this.notify({ state, latency, downlink, rtt }, controller);
                return;
            }
            // Cas 2 — ping configuré (tous navigateurs)
            // ou pas de navigator.connection (Firefox, Safari sans ping)
            if (this.pingUrl) {
                const { latency, downlink } = await this.probe(controller.signal);
                if (controller.signal.aborted)
                    return;
                // On complète rtt avec l'API si dispo, sinon on utilise la latence mesurée
                const rtt = nav.connection?.rtt ?? latency;
                const state = this.computeState(latency, downlink);
                this.notify({ state, latency, downlink, rtt }, controller);
                return;
            }
            // Cas 3 — pas de navigator.connection ET pas de ping
            // → poor défensif jusqu'à ce que l'API soit disponible
            this.notify({ state: "poor", latency: Infinity, downlink: 0, rtt: 0 }, controller);
        }
        catch (error) {
            if (error instanceof DOMException && error.name === "AbortError")
                return;
            throw error;
        }
        finally {
            if (this.evaluationController === controller) {
                this.evaluationController = null;
            }
        }
    }
    // ─── Probe ────────────────────────────────────────────────────────────────
    /**
     * Mesure latence (TTFB) et débit réel en une seule requête GET.
     * Universel — fonctionne sur tous les navigateurs sans navigator.connection.
     * L'endpoint doit servir un fichier statique léger (1–20 KB) avec CORS configuré.
     */
    async probe(signal) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.pingTimeoutMs);
        signal.addEventListener("abort", () => controller.abort(), { once: true });
        const url = new URL(this.pingUrl, window.location.origin);
        url.searchParams.set("t", Date.now().toString());
        const start = performance.now();
        try {
            const response = await fetch(url.toString(), {
                method: "GET", // GET pour avoir un body mesurable (HEAD = 0 octet)
                cache: "no-store",
                signal: controller.signal,
            });
            const ttfb = Math.round(performance.now() - start);
            const buffer = await response.arrayBuffer();
            const bytes = buffer.byteLength;
            const totalMs = performance.now() - start;
            const transfer = totalMs - ttfb; // temps de transfert seul, hors latence
            // Mbps = (bytes × 8) / (ms × 1000)
            const downlink = transfer > 0 && bytes > 0
                ? parseFloat(((bytes * 8) / (transfer * 1000)).toFixed(2))
                : 0;
            return { latency: ttfb, downlink };
        }
        catch {
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
        const nav = navigator;
        const type = nav.connection?.effectiveType;
        if (type === "4g" && latency < this.thresholds.maxLatency)
            return "good";
        if (type === "3g")
            return "degraded";
        if (type === "2g" || type === "slow-2g")
            return "poor";
        const downlink = nav.connection?.downlink ?? 0;
        if (downlink > this.thresholds.absoluteGood && latency < this.thresholds.maxLatency)
            return "good";
        if (downlink > this.thresholds.absolutePoor)
            return "degraded";
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
}
//# sourceMappingURL=NetworkMonitor.js.map