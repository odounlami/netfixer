// RequestScheduler.ts — stable viable version
// ─── Constantes ───────────────────────────────────────────────────────────────
const DEFAULT_RULES = {
    good: ["critical", "normal", "background"],
    degraded: ["critical", "normal"],
    poor: ["critical"],
    offline: [],
};
const PRIORITY_ORDER = {
    critical: 0,
    normal: 1,
    background: 2,
};
const DEFAULT_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const STORAGE_KEY = "netfixer:queue";
const MAX_RETRIES = 3;
const FLUSH_EXPIRED_INTERVAL_MS = 1_000;
// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateId() {
    return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
function computeBackoff(retries, initial, max) {
    const base = Math.min(initial * 2 ** retries, max);
    const jitter = (Math.random() * 0.4 - 0.2) * base; // -20% à +20%
    return Math.max(0, Math.round(base + jitter));
}
function sanitizePositiveNumber(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.floor(value));
}
function sanitizeNullableDuration(value) {
    if (value == null)
        return null;
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    return Math.max(0, Math.floor(value));
}
function sanitizeRetryableStatuses(statuses) {
    if (!Array.isArray(statuses) || statuses.length === 0) {
        return DEFAULT_RETRYABLE_STATUSES;
    }
    const cleaned = [
        ...new Set(statuses.filter((status) => Number.isInteger(status) && status >= 100 && status <= 599)),
    ];
    return cleaned.length > 0 ? cleaned : DEFAULT_RETRYABLE_STATUSES;
}
function isStorageAvailable(storage) {
    try {
        const testKey = "__netfixer_test__";
        storage.setItem(testKey, "1");
        storage.removeItem(testKey);
        return true;
    }
    catch {
        return false;
    }
}
function getAvailableStorages() {
    if (typeof window === "undefined")
        return [];
    const storages = [];
    if (typeof localStorage !== "undefined" && isStorageAvailable(localStorage)) {
        storages.push(localStorage);
    }
    if (typeof sessionStorage !== "undefined" &&
        isStorageAvailable(sessionStorage)) {
        storages.push(sessionStorage);
    }
    return storages;
}
/**
 * Fusionne plusieurs AbortSignals en un seul.
 * Le signal retourné est aborted dès que l'un des signaux sources l'est.
 * Les listeners sont correctement nettoyés après abort pour éviter les fuites mémoire.
 */
function mergeAbortSignals(signals) {
    const controller = new AbortController();
    const validSignals = signals.filter((s) => s != null);
    if (validSignals.some((signal) => signal.aborted)) {
        controller.abort();
        return controller.signal;
    }
    const onAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
        // Nettoyage des listeners sur tous les signaux sources
        for (const signal of validSignals) {
            signal.removeEventListener("abort", onAbort);
        }
    };
    for (const signal of validSignals) {
        signal.addEventListener("abort", onAbort, { once: true });
    }
    return controller.signal;
}
function isPersistableBody(body) {
    if (body == null)
        return true;
    if (typeof body === "string")
        return true;
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        return true;
    }
    // Tous les autres types BodyInit valides (ReadableStream, FormData,
    // Blob, ArrayBuffer, ArrayBufferView) ne sont pas sérialisables en JSON
    return false;
}
// ─── RequestScheduler ─────────────────────────────────────────────────────────
export class RequestScheduler {
    monitor;
    queue = [];
    rules;
    initialBackoffMs;
    maxBackoffMs;
    defaultTimeoutMs;
    retryableStatuses;
    persistEnabled;
    loggingEnabled;
    defaultMaxQueueAgeMs;
    inFlight = new Set();
    unsubscribeMonitor = null;
    networkState;
    retryTimer = null;
    maxAgeTimer = null;
    destroyed = false;
    constructor(options) {
        this.monitor = options.monitor;
        this.networkState = this.monitor.getState();
        this.initialBackoffMs = sanitizePositiveNumber(options.initialBackoffMs, 1_000);
        this.maxBackoffMs = Math.max(this.initialBackoffMs, sanitizePositiveNumber(options.maxBackoffMs, 30_000));
        this.defaultTimeoutMs = sanitizePositiveNumber(options.defaultTimeoutMs, 10_000);
        this.retryableStatuses = sanitizeRetryableStatuses(options.retryableStatuses);
        this.persistEnabled = options.persist ?? false;
        this.loggingEnabled = options.logging ?? false;
        this.defaultMaxQueueAgeMs = sanitizeNullableDuration(options.maxQueueAgeMs);
        this.rules = { ...DEFAULT_RULES, ...options.rules };
        this.unsubscribeMonitor = this.monitor.onChange((info) => {
            if (this.destroyed)
                return;
            this.networkState = info.state;
            this.flush();
        });
        this.maxAgeTimer = setInterval(() => {
            this.flushExpired();
        }, FLUSH_EXPIRED_INTERVAL_MS);
        if (this.persistEnabled) {
            this.restoreQueue();
        }
    }
    /**
     * Arrête le scheduler, nettoie les ressources et rejette les requêtes en attente.
     */
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.maxAgeTimer !== null) {
            clearInterval(this.maxAgeTimer);
            this.maxAgeTimer = null;
        }
        if (this.unsubscribeMonitor !== null) {
            this.unsubscribeMonitor();
            this.unsubscribeMonitor = null;
        }
        for (const request of this.queue) {
            request.reject(new Error("[netfixer] scheduler détruit"));
        }
        this.queue.length = 0;
        this.inFlight.clear();
        this.persistQueue();
    }
    /**
     * Envoie une requête en respectant les règles de priorité réseau.
     *
     * @remarks
     * Si `persist: true` et que la page est rechargée, la promesse retournée
     * par cet appel est perdue. La requête partira en arrière-plan au prochain
     * démarrage, mais son résultat ne sera jamais accessible depuis le code appelant.
     * Comportement intentionnel ("fire-and-forget persistant").
     */
    fetch(url, init = {}) {
        if (this.destroyed) {
            return Promise.reject(new Error("[netfixer] scheduler détruit"));
        }
        const { netPriority = "normal", timeoutMs = this.defaultTimeoutMs, persist = this.persistEnabled, maxQueueAgeMs = this.defaultMaxQueueAgeMs, ...fetchInit } = init;
        const normalizedTimeoutMs = sanitizePositiveNumber(timeoutMs, this.defaultTimeoutMs);
        const normalizedMaxQueueAgeMs = sanitizeNullableDuration(maxQueueAgeMs);
        return new Promise((resolve, reject) => {
            const request = {
                id: generateId(),
                url,
                init: fetchInit,
                priority: netPriority,
                timeoutMs: normalizedTimeoutMs,
                persist,
                retries: 0,
                queuedAt: Date.now(),
                maxQueueAgeMs: normalizedMaxQueueAgeMs,
                resolve,
                reject,
            };
            this.log(`[fetch] ${url} — priority: ${netPriority} — network: ${this.networkState}`);
            if (this.canSend(netPriority)) {
                void this.send(request);
            }
            else {
                this.enqueue(request);
            }
        });
    }
    // ─── File d'attente ───────────────────────────────────────────────────────
    enqueue(request) {
        if (this.destroyed)
            return;
        if (request.persist && !isPersistableBody(request.init.body)) {
            this.log(`[warn] persist:true avec un body non sérialisable sur ${request.url} — persistance désactivée`);
            request.persist = false;
        }
        this.queue.push(request);
        this.log(`[queued] ${request.url} — queue: ${this.queue.length}`);
        this.persistQueue();
    }
    flush() {
        if (this.destroyed)
            return;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.networkState === "offline" || this.queue.length === 0) {
            this.log(`[flush] skipped — network: ${this.networkState} — queue: ${this.queue.length}`);
            return;
        }
        this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
            a.queuedAt - b.queuedAt);
        const pending = this.queue.splice(0);
        for (const request of pending) {
            if (this.canSend(request.priority)) {
                this.log(`[flush] sending ${request.url} — network: ${this.networkState}`);
                void this.send(request);
            }
            else {
                this.queue.push(request);
            }
        }
        if (this.queue.length > 0) {
            const maxRetries = Math.max(...this.queue.map((r) => r.retries));
            this.scheduleRetry(maxRetries);
        }
        this.persistQueue();
    }
    /**
     * Force l'envoi des requêtes qui ont dépassé leur maxQueueAgeMs.
     * N'envoie jamais si l'état réseau est offline.
     */
    flushExpired() {
        if (this.destroyed || this.queue.length === 0)
            return;
        const now = Date.now();
        const pending = this.queue.splice(0);
        for (const request of pending) {
            const age = now - request.queuedAt;
            const maxAge = request.maxQueueAgeMs;
            if (maxAge !== null && age >= maxAge) {
                if (this.networkState === "offline") {
                    this.queue.push(request);
                    continue;
                }
                this.log(`[expired] ${request.url} — ${age}ms en file — envoi forcé`);
                void this.send(request);
            }
            else {
                this.queue.push(request);
            }
        }
        this.persistQueue();
    }
    scheduleRetry(retries = 0) {
        if (this.destroyed)
            return;
        if (this.retryTimer !== null)
            return;
        if (this.queue.length === 0)
            return;
        const delay = computeBackoff(retries, this.initialBackoffMs, this.maxBackoffMs);
        this.log(`[retry] prochain flush dans ${delay}ms — network: ${this.networkState}`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.flush();
        }, delay);
    }
    // ─── Envoi ────────────────────────────────────────────────────────────────
    async send(request) {
        if (this.destroyed) {
            request.reject(new Error("[netfixer] scheduler détruit"));
            return;
        }
        if (this.inFlight.has(request.id)) {
            this.log(`[guard] ${request.url} (${request.id}) déjà en vol — doublon ignoré`);
            return;
        }
        this.inFlight.add(request.id);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
        try {
            const mergedSignal = mergeAbortSignals([
                request.init.signal,
                controller.signal,
            ]);
            const response = await fetch(request.url, {
                ...request.init,
                signal: mergedSignal,
            });
            if (!response.ok && this.retryableStatuses.includes(response.status)) {
                this.log(`[http-error] ${request.url} — status: ${response.status} — network: ${this.networkState}`);
                this.handleRetry(request, new Error(`HTTP ${response.status}`));
                return;
            }
            this.removePersisted(request.id);
            if (!this.destroyed) {
                request.resolve(response);
            }
        }
        catch (error) {
            const isAbort = error instanceof DOMException && error.name === "AbortError";
            if (isAbort) {
                this.log(`[timeout/abort] ${request.url} — retry ${request.retries + 1}/${MAX_RETRIES} — network: ${this.networkState}`);
            }
            else {
                const tag = error instanceof TypeError ? "[error:network/CORS-or-DNS]" : "[error]";
                this.log(`${tag} ${request.url} — ${String(error)} — network: ${this.networkState}`);
            }
            this.handleRetry(request, error);
        }
        finally {
            clearTimeout(timeout);
            this.inFlight.delete(request.id);
        }
    }
    handleRetry(request, error) {
        if (this.destroyed) {
            request.reject(new Error("[netfixer] scheduler détruit"));
            return;
        }
        if (request.retries < MAX_RETRIES) {
            request.retries += 1;
            this.enqueue(request);
            this.scheduleRetry(request.retries);
            return;
        }
        this.log(`[dead] ${request.url} — max retries atteint`);
        this.removePersisted(request.id);
        request.reject(error ?? new Error(`Max retries atteint pour ${request.url}`));
    }
    canSend(priority) {
        return this.rules[this.networkState].includes(priority);
    }
    // ─── Persistance ──────────────────────────────────────────────────────────
    persistQueue() {
        if (!this.persistEnabled)
            return;
        const storages = getAvailableStorages();
        if (storages.length === 0) {
            this.log("[persist] aucun storage disponible");
            return;
        }
        const serializable = this.queue
            .filter((r) => r.persist)
            .map(({ id, url, init, priority, timeoutMs, retries, queuedAt, maxQueueAgeMs }) => ({
            id,
            url,
            init,
            priority,
            timeoutMs,
            retries,
            queuedAt,
            maxQueueAgeMs,
        }));
        for (const storage of storages) {
            try {
                if (serializable.length === 0) {
                    storage.removeItem(STORAGE_KEY);
                }
                else {
                    storage.setItem(STORAGE_KEY, JSON.stringify(serializable));
                }
            }
            catch (e) {
                this.log(`[persist] échec écriture storage — ${String(e)}`);
            }
        }
    }
    removePersisted(id) {
        if (!this.persistEnabled)
            return;
        const storages = getAvailableStorages();
        if (storages.length === 0)
            return;
        for (const storage of storages) {
            try {
                const raw = storage.getItem(STORAGE_KEY);
                if (!raw)
                    continue;
                const persisted = JSON.parse(raw);
                const next = persisted.filter((r) => r.id !== id);
                if (next.length === 0) {
                    storage.removeItem(STORAGE_KEY);
                }
                else {
                    storage.setItem(STORAGE_KEY, JSON.stringify(next));
                }
            }
            catch {
                this.log("[persist] échec de la suppression");
            }
        }
    }
    restoreQueue() {
        const storages = getAvailableStorages();
        if (storages.length === 0)
            return;
        for (const storage of storages) {
            try {
                const raw = storage.getItem(STORAGE_KEY);
                if (!raw)
                    continue;
                const persisted = JSON.parse(raw);
                for (const item of persisted) {
                    const request = {
                        id: item.id,
                        url: item.url,
                        init: item.init,
                        priority: item.priority,
                        timeoutMs: item.timeoutMs,
                        persist: true,
                        retries: item.retries,
                        queuedAt: item.queuedAt,
                        maxQueueAgeMs: item.maxQueueAgeMs,
                        // Comportement fire-and-forget documenté : la promesse originale
                        // est perdue au reload, les callbacks sont des no-ops loggés.
                        resolve: () => {
                            this.log(`[restore:resolve] ${item.url} livré après reload — résultat non accessible`);
                        },
                        reject: (reason) => {
                            this.log(`[restore:reject] ${item.url} échoué après reload — ${String(reason)}`);
                        },
                    };
                    this.queue.push(request);
                }
                this.log(`[restore] ${persisted.length} requête(s) restaurée(s) — network: ${this.networkState}`);
                this.persistQueue();
                this.flushExpired();
                this.flush();
                return;
            }
            catch {
                this.log("[restore] échec de lecture");
                try {
                    storage.removeItem(STORAGE_KEY);
                }
                catch {
                    this.log("[restore] impossible de nettoyer le storage corrompu");
                }
            }
        }
    }
    // ─── Utils ────────────────────────────────────────────────────────────────
    log(message) {
        if (this.loggingEnabled) {
            console.log(`[netfixer] ${message}`);
        }
    }
}
//# sourceMappingURL=RequestScheduler.js.map