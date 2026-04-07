# Contributing to Spotify Archive Downloader

Thank you for your interest in contributing to the Spotify Archive Downloader architecture. We highly encourage disciplined Pull Requests targeting runtime performance optimizations, metadata extraction resiliency enhancements, and overall systemic stability.

## Contribution Protocol

### Filing Architectural Constraints & Bugs
When reporting vulnerabilities or parsing failures, construct a detailed diagnostic report in the Issue Tracker containing:
- Baseline environment telemetry (OS distribution, Core Python runtime version, FFmpeg iteration).
- Detailed FastAPI console tracebacks illustrating concurrent task failures.
- Direct context to the DOM structural anomalies preventing the `spotify_scraper.js` script from aggregating targets correctly.

### Feature Proposals
Algorithmic optimizations, such as incorporating alternative backend search topologies or altering the `mutagen` schema structures, should first be discussed via an Enhancement Request. We evaluate features strictly on their computational overhead and network efficiency footprint.

### Development & Pull Request Lifecycle

1. Fork the baseline repository to establish your isolated working environment.
2. Clone the project to your local workspace.
3. Instantiate a functional branch tracking your specific integration:
   `git checkout -b feature/component-optimization`
4. Execute and test implementations locally. Ensure you validate error thresholds against large array datasets (e.g., verifying `ThreadPoolExecutor` does not induce process starvation).
5. Stage, commit, and push modifications back to your origin.
6. Submit a formal Pull Request against the `main` branch.

## System Architecture Guidelines

### Core Constraints (Python / FastAPI Backend, `/backend`)
- **PEP-8 Static Formatting**: Source code must strictly comply with established PEP-8 conventions.
- **Asynchronous Execution Strategy**: The system routes network payloads through the asynchronous event loop heavily. Ensure that executing disk-based I/O implementations (such as encoding logic within `tagger.py`) never block the native loop thread. Always dispatch heavily synchronous functions inside standard executors (`run_in_executor`).
- **Idempotent Job Processing**: Ensure local database bindings via `database.py` remain entirely transactional. The system logic dictates that abrupt sig-term exits must strictly flag jobs dynamically, allowing them to rebuild queued status on process resume.
- **Strict Typing**: Implement mandatory runtime type enforcement leveraging Python's `typing` semantics across all modular signatures.

### Client Infrastructure Methods (Manifest V3 / JS, `/extension`)
- **Strict Content Security Policies (CSP)**: Abide by strict execution permissions enforced by MV3. External module evaluations including inline-script definitions (`eval()`) are outright prohibited.
- **Vanilla DOM Operations**: The stack excludes any external frameworks in favor of optimized native DOM interrogation techniques. Prevent structural mutation overhead during interval-based DOM polling.
- **Service Worker Lifecycle Limits**: Assume the background context (`service_worker.js`) behaves ephemerally. Maintain application states solely within the persistent `chrome.storage.local` construct to avoid orphaned states or variable regressions upon worker destruction.

### Internationalization (i18n)
String literals representing GUI interactions require hardcoded abstract references inside `i18n.js` and `locales` implementations. Avoid inline definitions during feature builds to prevent fracturing dynamic bilingual (EN/TR) component tree parsing.

We appreciate your commitment to building highly resilient and persistent archival utilities.
