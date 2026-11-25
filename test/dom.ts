import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * A DOM (happy-dom) for the React tests, registered once for the whole run (`bunfig.toml`
 * preload) before React or testing-library load. Bun's own `fetch`, `Response`, `crypto` and
 * timers are kept: the server and signer tests use them.
 */
const own = { fetch, Request, Response, Headers, crypto, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextEncoder, TextDecoder };
GlobalRegistrator.register({ url: 'https://app.test/' });
Object.assign(globalThis, own);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
