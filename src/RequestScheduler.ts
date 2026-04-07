// RequestScheduler.ts — v0.5.0

import type { NetworkMonitor, NetworkState } from "./NetworkMonitor.js";

// ─── Types publics ────────────────────────────────────────────────────────────

export type NetPulsePriority = "critical" | "normal" | "background";

export type PriorityRules = Record<NetworkState, NetPulsePriority[]>;

export type FetchBaseInit = Omit<
  SchedulerRequestInit,
  "netPriority" | "timeoutMs" | "persist" | "maxQueueAgeMs"
>;

export interface SchedulerRequestInit extends RequestInit {
  netPriority?: NetPulsePriority;
  timeoutMs?:   number;
  persist?:     boolean;

  /**
   * Durée max en ms qu'une requête peut rester en file d'attente.
   * Passé ce délai, elle est envoyée quand même — peu importe l'état réseau.
   *
   * Exemple : maxQueueAgeMs: 30_000
   */
  maxQueueAgeMs?: number;
}

export interface RequestSchedulerOptions {
  monitor: NetworkMonitor;
  rules?:  Partial<PriorityRules>;

  /** Délai initial du backoff exponentiel en ms. Défaut : 1000ms. */
  initialBackoffMs?: number;

  /** Plafond du backoff en ms. Défaut : 30000ms. */
  maxBackoffMs?: number;

  /** Timeout global par requête en ms. Défaut : 10000ms. */
  defaultTimeoutMs?: number;

  /**
   * Codes HTTP qui déclenchent un retry.
   * Défaut : [429, 500, 502, 503, 504]
   */
  retryableStatuses?: number[];

  /**
   * Active la persistance de la file.
   * Tente localStorage d'abord, puis sessionStorage en fallback.
   * Les requêtes marquées persist:true survivent à un reload.
   * Note : les requêtes avec un body non sérialisable (ReadableStream, fonctions)
   * sont automatiquement exclues de la persistance avec un avertissement.
   */
  persist?: boolean;

  /**
   * Durée max globale en ms qu'une requête peut rester en file d'attente.
   * Peut être surchargée par requête via maxQueueAgeMs.
   */
  maxQueueAgeMs?: number;

  /** Active les logs de debug dans la console. */
  logging?: boolean;
}

// ─── Types internes ───────────────────────────────────────────────────────────

interface QueuedRequest {
  id:            string;
  url:           string;
  init:          FetchBaseInit;
  priority:      NetPulsePriority;
  timeoutMs:     number;
  persist:       boolean;
  retries:       number;
  queuedAt:      number;
  maxQueueAgeMs: number | null;
  resolve:       (response: Response) => void;
  reject:        (reason: unknown) => void;
}

interface PersistedRequest {
  id:            string;
  url:           string;
  init:          FetchBaseInit;
  priority:      NetPulsePriority;
  timeoutMs:     number;
  retries:       number;
  queuedAt:      number;
  maxQueueAgeMs: number | null;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const DEFAULT_RULES: PriorityRules = {
  good:     ["critical", "normal", "background"],
  degraded: ["critical", "normal"],
  poor:     ["critical"],
  offline:  [],
};

// [Fix 2] Ordre numérique pour le tri du min-heap léger dans flush()
const PRIORITY_ORDER: Record<NetPulsePriority, number> = {
  critical:   0,
  normal:     1,
  background: 2,
};

const DEFAULT_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
const STORAGE_KEY = "netfixer:queue";
const MAX_RETRIES = 3;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function computeBackoff(retries: number, initial: number, max: number): number {
  const base   = Math.min(initial * 2 ** retries, max);
  const jitter = Math.random() * base * 0.2;
  return Math.round(base + jitter);
}

// ─── RequestScheduler ─────────────────────────────────────────────────────────

export class RequestScheduler {
  private readonly monitor:              NetworkMonitor;
  private readonly queue:                QueuedRequest[] = [];
  private readonly rules:                PriorityRules;
  private readonly initialBackoffMs:     number;
  private readonly maxBackoffMs:         number;
  private readonly defaultTimeoutMs:     number;
  private readonly retryableStatuses:    number[];
  private readonly persistEnabled:       boolean;
  private readonly loggingEnabled:       boolean;
  private readonly defaultMaxQueueAgeMs: number | null;

  // [Fix 1] Set des IDs de requêtes actuellement en vol — anti double-envoi
  private readonly inFlight = new Set<string>();

  private networkState:   NetworkState;
  private retryTimer:     ReturnType<typeof setTimeout>   | null = null;
  private maxAgeTimer:    ReturnType<typeof setInterval>  | null = null;
  private destroyed       = false;

  constructor(options: RequestSchedulerOptions) {
    this.monitor              = options.monitor;
    this.networkState         = this.monitor.getState();
    this.initialBackoffMs     = options.initialBackoffMs     ?? 1_000;
    this.maxBackoffMs         = options.maxBackoffMs         ?? 30_000;
    this.defaultTimeoutMs     = options.defaultTimeoutMs     ?? 10_000;
    this.retryableStatuses    = options.retryableStatuses    ?? DEFAULT_RETRYABLE_STATUSES;
    this.persistEnabled       = options.persist              ?? false;
    this.loggingEnabled       = options.logging              ?? false;
    this.defaultMaxQueueAgeMs = options.maxQueueAgeMs        ?? null;

    this.rules = { ...DEFAULT_RULES, ...options.rules };

    this.monitor.onChange((info) => {
      if (this.destroyed) return;
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
  destroy(): void {
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
  fetch(url: string, init: SchedulerRequestInit = {}): Promise<Response> {
    if (this.destroyed) {
      return Promise.reject(new Error("[netfixer] scheduler détruit"));
    }

    const {
      netPriority    = "normal",
      timeoutMs      = this.defaultTimeoutMs,
      persist        = this.persistEnabled,
      maxQueueAgeMs  = this.defaultMaxQueueAgeMs,
      ...fetchInit
    } = init;

    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        id:            generateId(),
        url,
        init:          fetchInit,
        priority:      netPriority,
        timeoutMs,
        persist,
        retries:       0,
        queuedAt:      Date.now(),
        maxQueueAgeMs: maxQueueAgeMs ?? null,
        resolve,
        reject,
      };

      this.log(`[fetch] ${url} — priority: ${netPriority} — network: ${this.networkState}`);

      if (this.canSend(netPriority)) {
        void this.send(request);
      } else {
        this.enqueue(request);
      }
    });
  }

  // ─── File d'attente ───────────────────────────────────────────────────────

  private enqueue(request: QueuedRequest): void {
    if (this.destroyed) return;

    // [Fix 4] Détecter les bodies non sérialisables avant de persister
    if (request.persist && request.init.body !== undefined) {
      const isNonSerializable =
        typeof request.init.body === "function" ||
        request.init.body instanceof ReadableStream;

      if (isNonSerializable) {
        this.log(
          `[warn] persist:true avec un body non sérialisable sur ${request.url} ` +
          `— persistance désactivée pour cette requête`
        );
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
  private flush(): void {
    if (this.destroyed) return;

    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.networkState === "offline" || this.queue.length === 0) {
      this.log(`[flush] skipped — network: ${this.networkState} — queue: ${this.queue.length}`);
      return;
    }

    // Trier : priorité d'abord (critical < normal < background), puis FIFO
    this.queue.sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        a.queuedAt - b.queuedAt
    );

    // splice(0) vide le tableau en place sans créer de copie intermédiaire
    const pending = this.queue.splice(0);

    for (const request of pending) {
      if (this.canSend(request.priority)) {
        this.log(`[flush] sending ${request.url} — network: ${this.networkState}`);
        void this.send(request);
      } else {
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
  private flushExpired(): void {
    if (this.destroyed || this.queue.length === 0) return;

    const now     = Date.now();
    const pending = this.queue.splice(0);

    for (const request of pending) {
      const age    = now - request.queuedAt;
      const maxAge = request.maxQueueAgeMs;

      if (maxAge !== null && age >= maxAge) {
        if (!navigator.onLine) {
          this.queue.push(request);
          continue;
        }
        this.log(`[expired] ${request.url} — ${age}ms en file — envoi forcé`);
        void this.send(request);
      } else {
        this.queue.push(request);
      }
    }

    this.persistQueue();
  }

  private scheduleRetry(retries = 0): void {
    if (this.destroyed) return;
    if (this.retryTimer !== null) return;

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
  private async send(request: QueuedRequest): Promise<void> {
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
    const timeout    = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await fetch(request.url, {
        ...request.init,
        signal: controller.signal,
      });

      if (!response.ok && this.retryableStatuses.includes(response.status)) {
        this.log(
          `[http-error] ${request.url} — status: ${response.status} — network: ${this.networkState}`
        );
        this.handleRetry(request, new Error(`HTTP ${response.status}`));
        return;
      }

      this.removePersisted(request.id);
      request.resolve(response);

    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === "AbortError";

      if (isAbort) {
        this.log(
          `[timeout] ${request.url} — retry ${request.retries + 1}/${MAX_RETRIES} — network: ${this.networkState}`
        );
      } else {
        // [Fix cosmétique] Distingue CORS/DNS des autres erreurs réseau
        const tag = error instanceof TypeError ? "[error:network/CORS-or-DNS]" : "[error]";
        this.log(`${tag} ${request.url} — ${String(error)} — network: ${this.networkState}`);
      }

      this.handleRetry(request, error);

    } finally {
      clearTimeout(timeout);
      // [Fix 1] Libère le slot inFlight dans tous les cas
      this.inFlight.delete(request.id);
    }
  }

  private handleRetry(request: QueuedRequest, error?: unknown): void {
    if (this.destroyed) {
      request.reject(new Error("[netfixer] scheduler détruit"));
      return;
    }

    if (request.retries < MAX_RETRIES) {
      request.retries += 1;
      this.enqueue(request);
      this.scheduleRetry(request.retries);
    } else {
      this.log(`[dead] ${request.url} — max retries atteint`);
      this.removePersisted(request.id);
      request.reject(error ?? new Error(`Max retries atteint pour ${request.url}`));
    }
  }

  private canSend(priority: NetPulsePriority): boolean {
    return this.rules[this.networkState].includes(priority);
  }

  // ─── Fix 3 — Persistance avec fallback sessionStorage ────────────────────

  /**
   * Tente de persister dans localStorage d'abord, puis sessionStorage
   * si localStorage est indisponible (quota dépassé, mode incognito strict…).
   */
  private persistQueue(): void {
    if (!this.persistEnabled) return;

    const serializable: PersistedRequest[] = this.queue
      .filter(r => r.persist)
      .map(({ id, url, init, priority, timeoutMs, retries, queuedAt, maxQueueAgeMs }) => ({
        id, url, init, priority, timeoutMs, retries, queuedAt, maxQueueAgeMs,
      }));

    const data = JSON.stringify(serializable);

    for (const storage of [localStorage, sessionStorage]) {
      try {
        storage.setItem(STORAGE_KEY, data);
        return; // succès sur le premier storage disponible
      } catch (e) {
        this.log(
          `[persist] échec sur ${storage === localStorage ? "localStorage" : "sessionStorage"} — ${String(e)}`
        );
      }
    }
    // Les deux ont échoué (incognito strict, quota dépassé partout)
    this.log("[persist] aucun storage disponible — requêtes non persistées");
  }

  private removePersisted(id: string): void {
    if (!this.persistEnabled) return;

    for (const storage of [localStorage, sessionStorage]) {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) continue;
        const persisted = JSON.parse(raw) as PersistedRequest[];
        storage.setItem(STORAGE_KEY, JSON.stringify(persisted.filter(r => r.id !== id)));
        return;
      } catch {
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
  private restoreQueue(): void {
    for (const storage of [localStorage, sessionStorage]) {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) continue;

        const persisted = JSON.parse(raw) as PersistedRequest[];

        for (const item of persisted) {
          const request: QueuedRequest = {
            id:            item.id,
            url:           item.url,
            init:          item.init,
            priority:      item.priority,
            timeoutMs:     item.timeoutMs,
            persist:       true,
            retries:       item.retries,
            queuedAt:      item.queuedAt,
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

        this.log(
          `[restore] ${persisted.length} requête(s) restaurée(s) depuis ` +
          `${storage === localStorage ? "localStorage" : "sessionStorage"} — network: ${this.networkState}`
        );

        this.persistQueue();
        this.flushExpired();
        this.flush();
        return;

      } catch {
        this.log("[restore] échec de lecture");
      }
    }
  }

  // ─── Utils ────────────────────────────────────────────────────────────────

  private log(message: string): void {
    if (this.loggingEnabled) {
      console.log(`[netfixer] ${message}`);
    }
  }
}