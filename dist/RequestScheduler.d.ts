import type { NetworkMonitor, NetworkState } from "./NetworkMonitor.js";
export type NetPulsePriority = "critical" | "normal" | "background";
export type PriorityRules = Record<NetworkState, NetPulsePriority[]>;
export type FetchBaseInit = Omit<SchedulerRequestInit, "netPriority" | "timeoutMs" | "persist" | "maxQueueAgeMs">;
export interface SchedulerRequestInit extends RequestInit {
    netPriority?: NetPulsePriority;
    timeoutMs?: number;
    persist?: boolean;
    /**
     * Durée max en ms qu'une requête peut rester en file d'attente.
     * Passé ce délai, elle est envoyée quand même — peu importe l'état réseau.
     *
     * Exemple : maxQueueAgeMs: 30000
     */
    maxQueueAgeMs?: number;
}
export interface RequestSchedulerOptions {
    monitor: NetworkMonitor;
    rules?: Partial<PriorityRules>;
    /**
     * Délai initial du backoff exponentiel en ms. Défaut : 1000ms.
     */
    initialBackoffMs?: number;
    /**
     * Plafond du backoff en ms. Défaut : 30000ms.
     */
    maxBackoffMs?: number;
    /**
     * Timeout global par requête en ms. Défaut : 10000ms.
     */
    defaultTimeoutMs?: number;
    /**
     * Codes HTTP qui déclenchent un retry.
     * Défaut : [429, 500, 502, 503, 504]
     */
    retryableStatuses?: number[];
    /**
     * Active la persistance de la file dans localStorage.
     * Les requêtes marquées persist:true survivent à un reload.
     */
    persist?: boolean;
    /**
     * Durée max globale en ms qu'une requête peut rester en file d'attente.
     * Peut être surchargée par requête via maxQueueAgeMs.
     */
    maxQueueAgeMs?: number;
    /**
     * Active les logs de debug dans la console.
     */
    logging?: boolean;
}
export declare class RequestScheduler {
    private readonly monitor;
    private readonly queue;
    private readonly rules;
    private readonly initialBackoffMs;
    private readonly maxBackoffMs;
    private readonly defaultTimeoutMs;
    private readonly retryableStatuses;
    private readonly persistEnabled;
    private readonly loggingEnabled;
    private readonly defaultMaxQueueAgeMs;
    private networkState;
    private retryTimer;
    private maxAgeTimer;
    private destroyed;
    constructor(options: RequestSchedulerOptions);
    /**
     * Arrête le scheduler et nettoie les ressources.
     */
    destroy(): void;
    fetch(url: string, init?: SchedulerRequestInit): Promise<Response>;
    private enqueue;
    private flush;
    /**
     * Force l'envoi des requêtes qui ont dépassé leur maxQueueAgeMs.
     */
    private flushExpired;
    private scheduleRetry;
    private send;
    private handleRetry;
    private canSend;
    private persistQueue;
    private removePersisted;
    private restoreQueue;
    private log;
}
//# sourceMappingURL=RequestScheduler.d.ts.map