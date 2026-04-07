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
     * Exemple : maxQueueAgeMs: 30_000
     */
    maxQueueAgeMs?: number;
}
export interface RequestSchedulerOptions {
    monitor: NetworkMonitor;
    rules?: Partial<PriorityRules>;
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
    private readonly inFlight;
    private networkState;
    private retryTimer;
    private maxAgeTimer;
    private destroyed;
    constructor(options: RequestSchedulerOptions);
    /** Arrête le scheduler et nettoie les ressources. */
    destroy(): void;
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
    fetch(url: string, init?: SchedulerRequestInit): Promise<Response>;
    private enqueue;
    /**
     * [Fix 2] flush() trié par priorité puis ancienneté (FIFO à priorité égale).
     * Utilise splice(0) pour vider le tableau en une seule opération sans cloner.
     * Évite aussi le double-déclenchement retry en annulant le timer existant.
     */
    private flush;
    /** Force l'envoi des requêtes qui ont dépassé leur maxQueueAgeMs. */
    private flushExpired;
    private scheduleRetry;
    /**
     * [Fix 1] Guard inFlight : un même ID ne peut jamais être envoyé deux fois
     * en parallèle, même si flush() et scheduleRetry() se déclenchent
     * quasi simultanément sur un changement réseau.
     */
    private send;
    private handleRetry;
    private canSend;
    /**
     * Tente de persister dans localStorage d'abord, puis sessionStorage
     * si localStorage est indisponible (quota dépassé, mode incognito strict…).
     */
    private persistQueue;
    private removePersisted;
    /**
     * [Fix 3] Lit depuis localStorage d'abord, puis sessionStorage en fallback.
     *
     * [Fix 5] Les resolve/reject des requêtes restaurées sont des no-ops loggés.
     * La promesse originale de l'appelant est perdue au reload — c'est le
     * comportement "fire-and-forget persistant" documenté dans fetch().
     */
    private restoreQueue;
    private log;
}
//# sourceMappingURL=RequestScheduler.d.ts.map