# Changelog

All notable changes to netfixer will be documented in this file.


## [0.4.0] — 2026-04-07

### Added
- `NetworkMonitor`: option `logging` pour activer les logs de debug
- `NetworkMonitor`: 4 pings rapides au démarrage (warmup) pour une baseline fiable dès le chargement
- `RequestScheduler`: option `maxQueueAgeMs` par requête — force l'envoi après N ms même si le réseau est mauvais

### Changed
- `NetworkMonitor`: probe utilise désormais HEAD + GET hybride pour réduire la consommation data
- `RequestScheduler`: `flush()` trie par priorité puis FIFO

### Fixed
- Race condition sur `evaluate()` lors d'événements réseau simultanés

## [0.3.0] — 2026-03-10

### Added
- Support Firefox et Safari via custom probe (sans `navigator.connection`)
- Persistance optionnelle de la queue dans localStorage
- Backoff exponentiel avec jitter sur les retries