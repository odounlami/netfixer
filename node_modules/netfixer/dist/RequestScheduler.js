// --- Constantes ---
const DEFAULT_RULES = {
    good: ["critical", "normal", "background"],
    degraded: ["critical", "normal"],
    poor: ["critical"],
    offline: [],
};
const DEFAULT_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const STORAGE_KEY = "netfixer:queue";
const MAX_RETRIES = 3;
function generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function computeBackoff(retries, initial, max) {
    const base = Math.min(initial * 2 ** retries, max);
    const jitter = Math.random() * base * 0.2;
    return Math.round(base + jitter);
}
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
    networkState;
    retryTimer = null;
    maxAgeTimer = null;
    destroyed = false;
    constructor(options) {
        this.monitor = options.monitor;
        this.networkState = this.monitor.getState();
        this.initialBackoffMs = options.initialBackoffMs ?? 1000;
        this.maxBackoffMs = options.maxBackoffMs ?? 30000;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10000;
        this.retryableStatuses = options.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
        this.persistEnabled = options.persist ?? false;
        this.loggingEnabled = options.logging ?? false;
        this.defaultMaxQueueAgeMs = options.maxQueueAgeMs ?? null;
        this.rules = { ...DEFAULT_RULES, ...options.rules };
        this.monitor.onChange((info) => {
            if (this.destroyed)
                return;
            this.networkState = info.state;
            this.flush();
        });
        this.maxAgeTimer = setInterval(() => {
            this.flushExpired();
        }, 1000);
        if (this.persistEnabled) {
            this.restoreQueue();
        }
    }
    /**
     * Arrête le scheduler et nettoie les ressources.
     */
    destroy() {
        this.destroyed = true;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.maxAgeTimer !== null) {
            clearInterval(this.maxAgeTimer);
            this.maxAgeTimer = null;
        }
    }
    fetch(url, init = {}) {
        if (this.destroyed) {
            return Promise.reject(new Error("[netfixer] scheduler détruit"));
        }
        const { netPriority = "normal", timeoutMs = this.defaultTimeoutMs, persist = this.persistEnabled, maxQueueAgeMs = this.defaultMaxQueueAgeMs, ...fetchInit } = init;
        return new Promise((resolve, reject) => {
            const request = {
                id: generateId(),
                url,
                init: fetchInit,
                priority: netPriority,
                timeoutMs,
                persist,
                retries: 0,
                queuedAt: Date.now(),
                maxQueueAgeMs: maxQueueAgeMs ?? null,
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
    // --- File d'attente ---
    enqueue(request) {
        if (this.destroyed)
            return;
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
        const pending = [...this.queue];
        this.queue.length = 0;
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
     */
    flushExpired() {
        if (this.destroyed || this.queue.length === 0)
            return;
        const now = Date.now();
        const pending = [...this.queue];
        this.queue.length = 0;
        for (const request of pending) {
            const age = now - request.queuedAt;
            const maxAge = request.maxQueueAgeMs;
            if (maxAge !== null && age >= maxAge) {
                if (!navigator.onLine) {
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
        const delay = computeBackoff(retries, this.initialBackoffMs, this.maxBackoffMs);
        this.log(`[retry] prochain flush dans ${delay}ms — network: ${this.networkState}`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.flush();
        }, delay);
    }
    // --- Envoi ---
    async send(request) {
        if (this.destroyed) {
            request.reject(new Error("[netfixer] scheduler détruit"));
            return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
        try {
            const response = await fetch(request.url, {
                ...request.init,
                signal: controller.signal,
            });
            if (!response.ok && this.retryableStatuses.includes(response.status)) {
                this.log(`[http-error] ${request.url} — status: ${response.status} — network: ${this.networkState}`);
                this.handleRetry(request, new Error(`HTTP ${response.status}`));
                return;
            }
            this.removePersisted(request.id);
            request.resolve(response);
        }
        catch (error) {
            const isAbort = error instanceof DOMException && error.name === "AbortError";
            if (isAbort) {
                this.log(`[timeout] ${request.url} — retry ${request.retries + 1}/${MAX_RETRIES} — network: ${this.networkState}`);
            }
            else {
                this.log(`[error] ${request.url} — ${String(error)} — network: ${this.networkState}`);
            }
            this.handleRetry(request, error);
        }
        finally {
            clearTimeout(timeout);
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
        }
        else {
            this.log(`[dead] ${request.url} — max retries atteint`);
            this.removePersisted(request.id);
            request.reject(error ?? new Error(`Max retries atteint pour ${request.url}`));
        }
    }
    canSend(priority) {
        return this.rules[this.networkState].includes(priority);
    }
    // --- Persistance ---
    persistQueue() {
        if (!this.persistEnabled)
            return;
        try {
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
            localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
        }
        catch {
            this.log("[persist] échec de la sauvegarde");
        }
    }
    removePersisted(id) {
        if (!this.persistEnabled)
            return;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw)
                return;
            const persisted = JSON.parse(raw);
            const updated = persisted.filter((r) => r.id !== id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        }
        catch {
            this.log("[persist] échec de la suppression");
        }
    }
    restoreQueue() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw)
                return;
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
                    resolve: () => { },
                    reject: () => { },
                };
                this.queue.push(request);
            }
            this.log(`[restore] ${persisted.length} requête(s) restaurée(s) — network: ${this.networkState}`);
            this.persistQueue();
            this.flushExpired();
            this.flush();
        }
        catch {
            this.log("[restore] échec de la lecture");
        }
    }
    log(message) {
        if (this.loggingEnabled) {
            console.log(`[netfixer] ${message}`);
        }
    }
}
//# sourceMappingURL=RequestScheduler.js.map