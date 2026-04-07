// RequestScheduler.ts — v0.5.0
// ─── Constantes ───────────────────────────────────────────────────────────────
const DEFAULT_RULES = {
    good: ["critical", "normal", "background"],
    degraded: ["critical", "normal"],
    poor: ["critical"],
    offline: [],
};
// [Fix 2] Ordre numérique pour le tri du min-heap léger dans flush()
const PRIORITY_ORDER = {
    critical: 0,
    normal: 1,
    background: 2,
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
    // [Fix 1] Set des IDs de requêtes actuellement en vol — anti double-envoi
    inFlight = new Set();
    networkState;
    retryTimer = null;
    maxAgeTimer = null;
    destroyed = false;
    constructor(options) {
        this.monitor = options.monitor;
        this.networkState = this.monitor.getState();
        this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
        this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
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
        }, 1_000);
        if (this.persistEnabled) {
            this.restoreQueue();
        }
    }
    /** Arrête le scheduler et nettoie les ressources. */
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
    /**
     * Envoie une requête en respectant les règles de priorité réseau.
     *
     * @remarks
     * Si `persist: true` et que la page est rechargée, la promesse retournée
     * par cet appel est perdue. La requête partira en arrière-plan au prochain
     * démarrage, mais son résultat ne sera jamais accessible depuis le code appelant.
     * Comportement intentionnel ("fire-and-forget persistant").
     *
     * Les requêtes avec un body non sérialisable (ReadableStream, fonctions)
     * sont automatiquement dépersistées avec un avertissement de log.
     */
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
    // ─── File d'attente ───────────────────────────────────────────────────────
    enqueue(request) {
        if (this.destroyed)
            return;
        // [Fix 4] Détecter les bodies non sérialisables avant de persister
        if (request.persist && request.init.body !== undefined) {
            const isNonSerializable = typeof request.init.body === "function" ||
                request.init.body instanceof ReadableStream;
            if (isNonSerializable) {
                this.log(`[warn] persist:true avec un body non sérialisable sur ${request.url} ` +
                    `— persistance désactivée pour cette requête`);
                request.persist = false;
            }
        }
        this.queue.push(request);
        this.log(`[queued] ${request.url} — queue: ${this.queue.length}`);
        this.persistQueue();
    }
    /**
     * [Fix 2] flush() trié par priorité puis ancienneté (FIFO à priorité égale).
     * Utilise splice(0) pour vider le tableau en une seule opération sans cloner.
     * Évite aussi le double-déclenchement retry en annulant le timer existant.
     */
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
        // Trier : priorité d'abord (critical < normal < background), puis FIFO
        this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
            a.queuedAt - b.queuedAt);
        // splice(0) vide le tableau en place sans créer de copie intermédiaire
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
            const maxRetries = Math.max(...this.queue.map(r => r.retries));
            this.scheduleRetry(maxRetries);
        }
        this.persistQueue();
    }
    /** Force l'envoi des requêtes qui ont dépassé leur maxQueueAgeMs. */
    flushExpired() {
        if (this.destroyed || this.queue.length === 0)
            return;
        const now = Date.now();
        const pending = this.queue.splice(0);
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
    // ─── Envoi ────────────────────────────────────────────────────────────────
    /**
     * [Fix 1] Guard inFlight : un même ID ne peut jamais être envoyé deux fois
     * en parallèle, même si flush() et scheduleRetry() se déclenchent
     * quasi simultanément sur un changement réseau.
     */
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
                // [Fix cosmétique] Distingue CORS/DNS des autres erreurs réseau
                const tag = error instanceof TypeError ? "[error:network/CORS-or-DNS]" : "[error]";
                this.log(`${tag} ${request.url} — ${String(error)} — network: ${this.networkState}`);
            }
            this.handleRetry(request, error);
        }
        finally {
            clearTimeout(timeout);
            // [Fix 1] Libère le slot inFlight dans tous les cas
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
    // ─── Fix 3 — Persistance avec fallback sessionStorage ────────────────────
    /**
     * Tente de persister dans localStorage d'abord, puis sessionStorage
     * si localStorage est indisponible (quota dépassé, mode incognito strict…).
     */
    persistQueue() {
        if (!this.persistEnabled)
            return;
        const serializable = this.queue
            .filter(r => r.persist)
            .map(({ id, url, init, priority, timeoutMs, retries, queuedAt, maxQueueAgeMs }) => ({
            id, url, init, priority, timeoutMs, retries, queuedAt, maxQueueAgeMs,
        }));
        const data = JSON.stringify(serializable);
        for (const storage of [localStorage, sessionStorage]) {
            try {
                storage.setItem(STORAGE_KEY, data);
                return; // succès sur le premier storage disponible
            }
            catch (e) {
                this.log(`[persist] échec sur ${storage === localStorage ? "localStorage" : "sessionStorage"} — ${String(e)}`);
            }
        }
        // Les deux ont échoué (incognito strict, quota dépassé partout)
        this.log("[persist] aucun storage disponible — requêtes non persistées");
    }
    removePersisted(id) {
        if (!this.persistEnabled)
            return;
        for (const storage of [localStorage, sessionStorage]) {
            try {
                const raw = storage.getItem(STORAGE_KEY);
                if (!raw)
                    continue;
                const persisted = JSON.parse(raw);
                storage.setItem(STORAGE_KEY, JSON.stringify(persisted.filter(r => r.id !== id)));
                return;
            }
            catch {
                this.log("[persist] échec de la suppression");
            }
        }
    }
    /**
     * [Fix 3] Lit depuis localStorage d'abord, puis sessionStorage en fallback.
     *
     * [Fix 5] Les resolve/reject des requêtes restaurées sont des no-ops loggés.
     * La promesse originale de l'appelant est perdue au reload — c'est le
     * comportement "fire-and-forget persistant" documenté dans fetch().
     */
    restoreQueue() {
        for (const storage of [localStorage, sessionStorage]) {
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
                        // [Fix 5] Callbacks explicitement documentés comme fire-and-forget
                        resolve: () => {
                            this.log(`[restore:resolve] ${item.url} livré après reload — résultat non accessible`);
                        },
                        reject: (reason) => {
                            this.log(`[restore:reject] ${item.url} échoué après reload — ${String(reason)}`);
                        },
                    };
                    this.queue.push(request);
                }
                this.log(`[restore] ${persisted.length} requête(s) restaurée(s) depuis ` +
                    `${storage === localStorage ? "localStorage" : "sessionStorage"} — network: ${this.networkState}`);
                this.persistQueue();
                this.flushExpired();
                this.flush();
                return;
            }
            catch {
                this.log("[restore] échec de lecture");
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