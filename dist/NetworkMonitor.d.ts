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
}
type Listener = (info: NetworkInfo) => void;
export declare class NetworkMonitor {
    private currentInfo;
    private firstEvaluationDone;
    private isRunning;
    private warmupDone;
    private evaluationController;
    private readonly listeners;
    private pingInterval;
    private readonly baseline;
    private readonly thresholds;
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
     * Lance WARMUP_COUNT pings rapides espacés de WARMUP_INTERVAL_MS.
     * Permet d'établir une baseline EWMA fiable en ~2s au lieu d'attendre
     * le premier intervalle normal (5s par défaut).
     */
    private runWarmup;
    private wait;
    private evaluate;
    /**
     * Mesure latence (TTFB) et débit réel en une seule requête GET.
     * Universel — fonctionne sur tous les navigateurs sans navigator.connection.
     * L'endpoint doit servir un fichier statique léger (1–20 KB) avec CORS configuré.
     */
    private probe;
    private computeState;
    private computeFromEffectiveType;
    private notify;
    private get hasConnectionAPI();
}
export {};
//# sourceMappingURL=NetworkMonitor.d.ts.map