export type NetworkState = "good" | "degraded" | "poor" | "offline";
export interface NetworkInfo {
    state: NetworkState;
    latency: number;
    downlink: number;
    rtt: number;
}
export interface NetworkThresholds {
    absoluteGood: number;
    absolutePoor: number;
    ratioGood: number;
    ratioDegraded: number;
    maxLatency: number;
}
export interface NetworkMonitorOptions {
    pingUrl?: string;
    pingIntervalMs?: number;
    pingTimeoutMs?: number;
    thresholds?: Partial<NetworkThresholds>;
    /**
     * Active les logs de debug dans la console.
     */
    logging?: boolean;
    /**
     * Nombre de probes consécutives avant un GET complet (recalibrage du débit).
     * Défaut : 6 — soit 1 GET toutes les 6 probes (≈ 5 HEAD + 1 GET).
     * Avec un interval de 5s, cela représente ~1 GET toutes les 30s.
     */
    downlinkResampleEvery?: number;
}
type Listener = (info: NetworkInfo) => void;
export declare class NetworkMonitor {
    private currentInfo;
    private firstEvaluationDone;
    private isRunning;
    private warmupDone;
    private isEvaluating;
    private evaluateDebounceTimer;
    private evaluationController;
    private probeCount;
    private lastKnownDownlink;
    private readonly downlinkResampleEvery;
    private readonly listeners;
    private pingInterval;
    private readonly baseline;
    private readonly thresholds;
    private readonly loggingEnabled;
    private readonly pingUrl;
    private readonly pingIntervalMs;
    private readonly pingTimeoutMs;
    private readonly onlineHandler;
    private readonly offlineHandler;
    private readonly connectionChangeHandler;
    constructor(options?: NetworkMonitorOptions);
    start(): void;
    stop(): void;
    onChange(listener: Listener): () => void;
    getState(): NetworkState;
    getInfo(): NetworkInfo;
    /**
     * Point d'entrée unique pour tous les handlers d'événements.
     * Absorbe les rafales (online + connection change simultanés) via un debounce 50ms.
     */
    private scheduleEvaluate;
    private runWarmup;
    private wait;
    /**
     * [Fix 1] Guard isEvaluating : empêche les évaluations concurrentes
     * même si les AbortControllers annulent les requêtes fetch en vol.
     */
    private evaluate;
    /**
     * Mesure la latence via HEAD (léger, ~0 octet) à chaque ping.
     * Tous les N pings (downlinkResampleEvery), fait un GET complet pour
     * recalibrer le débit réel. Utilise Resource Timing API si disponible
     * pour une mesure plus précise que le calcul maison.
     *
     * Économie : avec N=6 et interval=5s, ~1 GET pour 5 HEAD
     * soit ~83% de data économisée vs toujours faire un GET.
     */
    private probe;
    private computeState;
    private computeFromEffectiveType;
    private notify;
    private get hasConnectionAPI();
    private log;
}
export {};
//# sourceMappingURL=NetworkMonitor.d.ts.map