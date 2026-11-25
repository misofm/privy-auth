# @misofm/privy-auth: conventions

Read `README.md` first. It covers the entries, the API, the design split and the Privy apps rule.

- **One production Privy app for every product**; "Miso (Testnet)" is for development only. Never
  write an app ID in the package, its docs or its tests: each app keeps its IDs in its own build
  config and passes them in.
- **Scope:** only facts about Privy that hold for every Miso app. App behaviour (flows, timeouts,
  retries, error types, words on screen, API sessions) stays in the apps. If a change would make
  one app behave differently, it belongs in that app.
- **Entries and weight:**
  - `src/index.ts` (core) must never import `@mysten/sui`, `effect/http` or any Privy runtime.
    Privy is `import type` only, because apps load the core in their entry chunk.
  - Anything that needs the Sui SDK goes in `src/signer.ts` (`/signer`).
  - Server code goes in `src/server.ts` (`/server`): `effect`, WebCrypto and a `fetch` function
    (no `effect/http`: a Worker serving with `HttpServer` alone shouldn't carry `HttpClient`); no
    Privy types, no `@mysten/sui`, so it runs on Cloudflare Workers and Bun. Services come as
    values too (`PrivyKeys.makeJwks`, `fromKey`, `makeVerificationKey`), layers beside them.
  - React goes in `/react` (`src/react.ts`: `privy-actions.ts`, `sign-in.ts`, `sign-in-flow.ts`)
    and `/ui` (`src/ui.ts`, one module per part in `src/ui/`). Keep them a module per part so a
    bundler drops what an import doesn't use: `sign-in*.ts` never import Privy's runtime, and
    `ui/oauth-button.tsx`, `ui/marks.tsx`, `ui/consent-line.tsx` never import ui-sdk (the fan
    app's route-tree `SignInPending` uses them).
- **Effect 4, house style** (as the apps write it): every failure is
  a `Schema.TaggedError`; untrusted input (Privy's errors, linked accounts, tokens, JWKS) is
  decoded with `Schema`, never with hand-rolled guards; absence is `Option`, a synchronous check
  that can fail a `Result`; nothing throws or answers `undefined` for a failure (the one throw is
  `PrivySigner.sign`'s `InvalidSignature`, because the SDK calls it as a Promise). Services are
  `Context.Service` with static layers (and `make…` values), their methods
  `Effect.fn("Service.method")`; time comes from `Clock` (`withWallTime` for an app's own clock
  function), HTTP from a `fetch` function through `Effect.tryPromise`, WebCrypto the same, with
  typed errors. No `Effect.run*` under `src/`: React hooks run their programs through the app's
  `run` (`useSignIn`'s option), or hand Effects to the app (`usePrivyActions`). State and async in
  a hook are Effect (the sign-in flow: a pure, total `transition(state, event)` over a tagged
  union, applied in a `Ref`; actions forked into a `FiberSet` in its scope, each answering once;
  `Clock` and `Schedule` for the countdown); React state only mirrors it. A new state or
  event gets its row in the README's table and in the test's (`sign-in-flow.test.ts` checks every
  pair). Verify every Effect name in
  `node_modules/effect/dist/*.d.ts`; never write one from memory. Plain functions remain only
  where nothing can fail.
- **React and ui-sdk** are optional peers for `/react` and `/ui` only. The parts are unstyled:
  `className`, `classNames` for inner elements, words as props with defaults (each app keeps its
  look and wording; the fan app writes Title Case). A behaviour the two apps share belongs in
  `useSignIn`; how one app looks or words it never does. Under `exactOptionalPropertyTypes`, pass
  ui-sdk a `className` only when there is one (`ui/class-name.ts`).
- **The apps' own quirks stay theirs:** which failures they have words for, how they route and
  run the actions, when Privy loads. `usePrivyActions` holds only what Privy's hooks do the same
  for every app: Privy reports a sign-in before its hooks show the user, and `signRawHash` signs
  for the user its hooks showed at that render, so `onComplete` is held until `session` is
  `SignedIn`, `loginWithCode` succeeds after it, `createSuiWallet` once the hooks show the wallet,
  and every function calls Privy's latest; the email hook's `onError` unwired, the OAuth hook's
  callbacks being Privy's `login` event, callbacks subscribed once. Check such facts in
  `node_modules/@privy-io/react-auth/dist/esm` before relying on them.
- **Waits and retries** (the exceptions to Scope's "timeouts, retries stay in the apps"): the
  package limits only a wait one of its own Effects adds, and retries only a request of its own
  that is safe to repeat. Today: a call waiting for Privy's hooks to show what Privy just did
  (`SHOWN_TIMEOUT`), the JWKS fetch and its tries (`JWKS_*`), and the resend wait the screen
  shows (`RESEND_SECONDS`). Everything else is the apps': how long a step may take, trying a step
  again, and how long to wait for a Google or Apple return (`onComplete` is held with no limit).
  The package never retries a step that sends an email, spends one of a code's tries, or could
  make a wallet. Each has its row in the README's "Once, waits and retries"; a new one gets a
  row there.
- **Peers:** `effect` `>=4.1.2 <4.2`, required (the apps' 4.1.2; developed against
  4.1.2). `@mysten/sui` `2.38.0`, `@privy-io/react-auth` `3.52.0` and `@ui-sdk/react` +
  `@ui-sdk/core` `0.1.0-beta.17` sit at the apps' exact versions, `react` `>=19`; all optional.
  No runtime dependencies.
- **TypeScript:** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, NodeNext
  ESM. Relative imports end in `.js`. Build with `tsc` only (`tsconfig.build.json` → `dist/`).
  Untrusted input (tokens, linked accounts, JWKS) is read with guards, never cast blindly.
- **Docs:** each export gets a JSDoc saying what it means, not how it works. Keep the README's
  tables in step with the exports.
- **Tests:** `bun test` in `test/`. Effects run with `Effect.runPromise`, with time on
  `TestClock` (`effect/testing`) and HTTP from a stub `fetch`. Every export is tested, and
  coverage stays at 100% of lines and functions (`bun run test` prints it). Server tests use a
  locally generated ES256 key and crafted tokens, never the network. React tests (`*.test.tsx`)
  use testing-library on happy-dom, registered once for the run (`bunfig.toml` preloads
  `test/dom.ts`, which keeps Bun's own `fetch`, `Response`, `crypto` and timers); Privy's SDK is
  `mock.module`d; a hook's runtime is `Effect.runForkWith` over a `TestClock` context. The flow
  (`sign-in-flow.ts`) is tested as Effects without React.
- **Distribution:** public on npm as `@misofm/privy-auth` (MIT). `npm publish` runs the
  typecheck and the tests, then builds `dist` (`prepublishOnly`); `bun run pack` makes the same tarball locally. Bump `version` for
  every publish (a breaking change bumps the minor while it is 0.x), and move both apps to it
  together.
- **Before handing off:** run `bun run typecheck`, `bun run test` and `bun run build`, all clean.
- Git has no identity configured here: commit with
  `git -c user.name=BL -c user.email=bl@miso.fm commit`.
