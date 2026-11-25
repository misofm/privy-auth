# @misofm/privy-auth

Privy sign-in shared by every Miso product: the account's Privy embedded Sui wallet, identity
tokens, how to read Privy's failures, Privy's config, identity tokens verified on a server, and
the sign-in screen's flow (Privy's hooks as Effects, the screen's state machine, unstyled parts).
Each app keeps its own screen layout, look, flows around sign-in, errors and copy. This package
holds only what every app does the same way.

MIT licensed (`LICENSE`).

## Privy apps

Every Miso product (the fan app, Studio and any later one) signs in through
**one production Privy app**. A person then has one Privy account and one Sui address across all
products. **"Miso (Testnet)" is for development only.** Each app keeps the two IDs in its own
build config; this package names neither.

- A new product adds its domains to the production app's allowed domains (Privy dashboard) and
  uses this package. Don't create a Privy app per product.
- The app ID is a parameter the consuming app passes (`PrivyProvider appId`, `verifyIdentityToken`
  `appId`), usually from its build config (`VITE_PRIVY_APP_ID`). The package never hard-codes it.
- Every origin an app runs on has to be listed in the Privy app's allowed origins, local dev
  servers included. Otherwise Privy answers 403 and its iframe's `frame-ancestors` refuses the page.

## Entries

| Import | Loads | For |
| --- | --- | --- |
| `@misofm/privy-auth` | `effect` (`Schema`, `Option`); no React, no `@mysten/sui`; Privy as types only | the browser, at boot |
| `@misofm/privy-auth/signer` | `@mysten/sui` (Ed25519, BLAKE2b, base58) | the browser, lazily on first signature |
| `@misofm/privy-auth/server` | `effect`, WebCrypto, `fetch` | Cloudflare Workers, Bun, Node 20+ |
| `@misofm/privy-auth/react` | `effect`, React; `@privy-io/react-auth` for `usePrivyActions` only | the browser, with the sign-in screen (and inside `PrivyProvider`) |
| `@misofm/privy-auth/ui` | React, ui-sdk (`@ui-sdk/react` 0.1.0-beta.17) for the fields; `OAuthButton`, the marks and `ConsentLine` import no ui-sdk | the browser, the sign-in screen |

The package is written in Effect 4 (`effect` is a peer, `>=4.1.2 <4.2`):

- Every failure is a `Schema.TaggedError`.
- Untrusted input is decoded with `Schema`: Privy's errors, linked accounts, identity tokens and
  the JWKS.
- Absence is `Option`. A check that can fail synchronously is a `Result`.
- The server is an `Effect` over a `PrivyKeys` service.
- The sign-in screen is a state machine: a pure `transition(state, event)` over six states, run
  as Effects (the state in a `Ref`, the app's actions forked into its scope, time from `Clock`);
  React only renders it. The app runs it with its own runtime (`run`). See
  [The flow, as states](#the-flow-as-states).

Plain functions remain only where nothing can fail: `namesWallet`, `oauthReturnPending`,
`privyConfig`, `isSignedOutRefresh` and `isEmailAddress`.

### `@misofm/privy-auth`

| Export | What |
| --- | --- |
| `suiWalletAccount(linkedAccounts)` | `Option<{ address, publicKey: Option<string> }>`: the account's Privy embedded Sui wallet in Privy's `user.linkedAccounts`. Matches `type` `wallet`, `chainType` `sui`, and a `walletClientType` that is absent or starts with `privy`. The key stays encoded. |
| `emailOf(user)` | `Option<string>`: the email Privy verified, from the email login, else Google, else Apple. |
| `jwtEnd(token)` | `Option<number>`: when a JWT ends (`exp`, ms since the epoch). Unverified. |
| `namesWallet(token, address)` | Whether an identity token's `linked_accounts` names the Sui wallet at `address` (compared normalized). The API reads the address there, so a token made before the wallet existed is useless. Unverified. |
| `privyFailure(cause, step)` | Why a sign-in step failed, as one of the errors below. A pure function: nothing is thrown. |
| `WrongCode`, `CodeNotSent`, `TooManyTries`, `Cancelled`, `MethodDisabled`, `NotAllowed`, `Unreachable`, `Refused` | The failures, each a `Schema.TaggedError` with `code` (Privy's error code, if any) and `cause` (what the step rejected with). |
| `PrivyFailure` | Their union, as a schema and a type (`Schema.is(PrivyFailure)`). |
| `PrivyStep` | `'sendCode'`, `'loginWithCode'` or `'login'` (OAuth, an OAuth return, or the `login` event's `onError`). |
| `isSignedOutRefresh(cause)` | Whether a failed `getIdentityToken` means the sign-in is over: 401, 403, `missing_or_invalid_token` or `must_be_authenticated`. Anything else means Privy is unreachable, and the sign-in may still hold. |
| `OAuthProvider` | `'google' \| 'apple'`: the providers Miso's apps sign in with. |
| `PRIVY_OAUTH_PARAMS` | `['privy_oauth_state', 'privy_oauth_code', 'privy_oauth_provider']`: what Privy's OAuth return carries. A router that drops unknown search parameters must keep these. |
| `oauthReturnPending(url)` | Whether `url` (a URL, an href or a search string) carries all of `PRIVY_OAUTH_PARAMS`, meaning Privy has a Google or Apple return to finish. It loads nothing, so a first screen can show that it's busy. Not a URL: `false`. |
| `privyConfig({ theme?, accentColor? })` | `PrivyProvider`'s `config`. Login methods: email, Google and Apple. No wallet list, wallet login never first, no external wallets (no WalletConnect, Base or Coinbase), no automatic Ethereum or Solana wallets, no wallet UIs. |
| `SuiWalletAccount`, `UserEmails`, `PrivyConfigOptions` | Types. |

`privyFailure` reads Privy's code first, then HTTP 429, then the step:

| Error | When |
| --- | --- |
| `WrongCode` | `invalid_credentials` during `loginWithCode`: the code was mistyped, expired or out of tries |
| `Cancelled` | `oauth_user_denied`: the person declined at Google or Apple |
| `TooManyTries` | `too_many_requests`, or HTTP 429 |
| `MethodDisabled` | `disallowed_login_method` |
| `NotAllowed` | `allowlist_rejected` |
| `Unreachable` | `client_request_timeout` |
| `CodeNotSent` | anything else during `sendCode` |
| `Refused` | anything else |

`cause` is what the step's promise rejected with (a Privy error carrying `privyErrorCode` and
maybe `status`), or the bare code string that `onError` receives. Each app maps these errors onto
its own (the fan app onto `AuthFailed` reasons, Studio onto `StudioError`s), or uses them directly.
Errors an app has no word for fall back to the step's own failure.

### `@misofm/privy-auth/signer`

| Export | What |
| --- | --- |
| `suiWallet(linkedAccounts)` | `Result<Option<SuiWallet>, InvalidSuiWallet>`: the same wallet as `suiWalletAccount`, its key decoded and checked against the address. `None` means no Privy Sui wallet; `Some({ address, publicKey })` means one that can sign (address normalized); `InvalidSuiWallet` means one that can't. It reads synchronously in render. In an Effect, use `yield* Effect.fromResult(suiWallet(accounts))`. |
| `InvalidSuiWallet` | `Schema.TaggedError`; `reason` is `NoAddress`, `NoPublicKey`, `UnreadablePublicKey` or `NotTheAddressKey`. |
| `walletPublicKey(encoded)` | `Option<Ed25519PublicKey>`: the key as Privy encodes it, as hex of 32 bytes (with or without `0x`), hex of 33 bytes led by flag `00`, or base58 of 32 bytes. |
| `PrivySigner` | A `@mysten/sui` `Signer` (the SDK calls it with Promises). Build it with `PrivySigner.of(wallet, signHash)` or `new PrivySigner(publicKey, signHash)`. `sign(digest)` hands `0x`-hex to `signHash` (Privy's `signRawHash`), and rejects with `InvalidSignature` if anything but 64 bytes comes back. `signTransaction` and `signPersonalMessage` work unchanged. |
| `InvalidSignature` | `Schema.TaggedError` with the `length` Privy answered. |
| `SuiWallet`, `SignHash` | Types. |

### `@misofm/privy-auth/server`

| Export | What |
| --- | --- |
| `verifyIdentityToken(token, { appId })` | `Effect<VerifiedIdentity, InvalidIdentityToken \| PrivyKeysUnavailable, PrivyKeys>` (`Effect.fn`, span `verifyIdentityToken`). The time comes from `Clock`. |
| `VerifiedIdentity` | `{ userId, address, email: Option<string>, expiresAt }` (`expiresAt` in ms since the epoch). Key an account by `userId` or `address`, never by `email`: two Privy accounts can carry one address (an emailed code's, and Google's). |
| `PrivyKeys` | `Context.Service` with `get(kid: Option<string>) → Effect<Option<CryptoKey>, PrivyKeysUnavailable>` (span `PrivyKeys.get`). Its constructors are below. |
| `PrivyKeys.makeJwks(appId, { fetch? })` | `Effect<PrivyKeys["Service"]>`: the service itself, for apps that build services as values. Keys from `auth.privy.io/api/v1/apps/<appId>/jwks.json` through `fetch` (the global one by default; any function with its shape). Fetched on first use and kept (`Effect.cachedInvalidateWithTTL`). Fetched again, at most once a minute by `Clock`, when a token names an unknown `kid`. A try that gets no answer in 2 s (the request aborted), a 5xx or a 429 is made again, twice at most (about 100 ms, then 200 ms later, jittered); a refusal or a body that isn't JSON is not. 5 s in all. The first fetch failing isn't kept (the next call tries again), nor is a JWKS with no key that can verify; a key that won't import is skipped. A later fetch failing takes no key away: tokens of known keys still verify, and the token naming the unknown one fails with `PrivyKeysUnavailable` for that minute. Make it once per isolate and keep it. |
| `PrivyKeys.layerJwks(appId, { fetch? })` | `Layer<PrivyKeys>`: `makeJwks` as a layer. |
| `PrivyKeys.fromKey(key)` | `PrivyKeys["Service"]`, synchronously: one imported key (ECDSA P-256, `verify`) for every `kid` (tests, a key the app imported). |
| `PrivyKeys.makeVerificationKey(key)` | `Effect<PrivyKeys["Service"], PrivyKeysUnavailable>`: one key for every `kid`. `key` is the dashboard's verification key (PEM SPKI, or its bare base64) or an imported `CryptoKey`. A PEM that won't import fails. |
| `PrivyKeys.layerVerificationKey(key)` | `Layer<PrivyKeys, PrivyKeysUnavailable>`: `makeVerificationKey` as a layer. |
| `withWallTime(now)` | `(effect) => effect` with `Clock`'s wall time (`currentTimeMillis`, `currentTimeNanos`) read from `now: () => number`, and its monotonic time and `sleep` the ambient `Clock`'s. For an app that keeps its own clock function. Effect builds a `Clock` from a plain object (it has no constructor), and this is that object. |
| `Fetch`, `JwksOptions` | Types: `(url, { signal }) => Promise<Response>`, and `{ fetch? }`. |
| `InvalidIdentityToken` | `Schema.TaggedError`; `reason` (`IdentityTokenProblem`, a `Schema.Literals`) is `Malformed`, `WrongIssuer`, `WrongAudience`, `Expired`, `UnknownKey`, `BadSignature` or `NoSuiWallet`. |
| `PrivyKeysUnavailable` | `Schema.TaggedError` with `cause`: the keys couldn't be read. Try again; the token isn't at fault. |
| `IdentityTokenProblem` | Schema and type. |

The server entry doesn't import `effect/http`: the JWKS comes through a plain `fetch` (wrapped in
Effect, with typed failures), so a Worker that serves with `HttpServer` alone doesn't carry
`HttpClient`. A layer built with `FetchHttpClient.layer` provided still works: it no longer needs it.

A token is accepted only if all of these hold:

- It is a compact JWS with `alg` ES256.
- Its header and claims decode with `Schema`.
- It is signed by the key `PrivyKeys` gives for its `kid`.
- `iss` is `privy.io`.
- `aud` is `appId`.
- `exp` hasn't passed by `Clock` (30 s of skew allowed).
- It has a `sub` (Privy's user ID), not empty.
- Its `linked_accounts` (a JSON string) name a Privy embedded Sui wallet (`wallet_client_type`
  absent, null, or `privy…`) at a Sui address (hex, 32 bytes at most). The first such wallet is
  the account's.

`address` is normalized. `email` is the email login's address, else the Google or Apple login's
email, and only when it contains `@`.

```ts
import { Effect } from 'effect';
import { PrivyKeys, verifyIdentityToken, withWallTime } from '@misofm/privy-auth/server';

// Once per isolate (keep the value, so its JWKS cache lasts):
const keys = yield* PrivyKeys.makeJwks(appId);
// Per request:
const who = verifyIdentityToken(bearer, { appId }).pipe(
  Effect.provideService(PrivyKeys, keys),
  withWallTime(Date.now), // only if the app keeps its own clock function; else Clock is Effect's
  Effect.catchTags({ InvalidIdentityToken: () => notSignedIn, PrivyKeysUnavailable: () => tryAgain }),
);
// Or as a layer: PrivyKeys.layerJwks(appId). In tests: PrivyKeys.fromKey(publicKey).
```

### `@misofm/privy-auth/react`

React `>=19` is a peer; `@privy-io/react-auth` `3.52.0` too, for `usePrivyActions` only (a bundler
that tree-shakes leaves Privy out of a chunk that uses `useSignIn` alone).

| Export | What |
| --- | --- |
| `usePrivyActions(callbacks?)` | `PrivyActions`: Privy's hooks as one value. Call it once, inside `PrivyProvider`, mounted where Google or Apple return. `callbacks.onComplete(user)` means someone is signed in **and Privy's hooks act for them** (`session` is `SignedIn`): each emailed code accepted, a Google or Apple return, a kept sign-in found on load. Privy reports a sign-in before its hooks show the user, and its wallet won't sign until they do; the report is held until then, and `onComplete` is called once per sign-in from an effect after that render, so the wallet signs from inside it and an app need not gate on `ready` or `authenticated`. `callbacks.onError(failure)` hears Privy's `login` event failing, as a `PrivyFailure`, at once. The callbacks are subscribed once and call the latest given. |
| `PrivyActions` | `{ ready, authenticated, user: Option<User>, session, identityToken: Option<string> }` and the functions below. One value while nothing in it changes; the functions keep their identity for the life of the hook and call Privy's latest, so one taken from an earlier render is never stale. |
| `.session` | `PrivySession`: `ready`, `authenticated` and `user` as one state. `Loading` (Privy doesn't know yet), `SignedOut`, `SigningIn` (Privy has a sign-in its hooks don't show whole yet: wait) or `SignedIn` with its `user` (the wallet signs). Read this in place of `ready && authenticated ? user : null`. |
| `.sendCode(email)` | `Effect<void, PrivyFailure>`: done once Privy has sent the code. |
| `.loginWithCode(code)` | `Effect<void, PrivyFailure>` (`WrongCode` when Privy refuses the code). Succeeds once Privy's hooks show the user it signed in and `onComplete` has been called with them; `Refused` if they never do (10 s by `Clock`). |
| `.initOAuth(provider)` | `Effect<void, PrivyFailure>`: done as the page is sent to Google or Apple (same tab). Privy finishes the sign-in where the page comes back. |
| `.createSuiWallet` | `Effect<User, PrivyCallFailed>`: makes the signed-in account's Privy embedded Sui wallet (`createWallet({ chainType: 'sui' })`) unless it has one, and answers the user with it once Privy's hooks show it, so it signs at once. Never a second wallet from this hook: it reads the user the hooks show signed in (waiting for them while Privy loads or finishes a sign-in), calls made together share one request, and a wallet Privy has answered is not asked for again, so trying it again is safe. Fails when no one is signed in, and when the hooks don't show the user, or the wallet made, in 10 s (by `Clock`). |
| `.refreshIdentityToken` | `Effect<Option<string>, PrivyCallFailed>`: a fresh token (`getIdentityToken`); `None` when no one is signed in. `isSignedOutRefresh(failure.cause)` tells a sign-in that is over. |
| `.signRawHash(address, hash)` | `Promise<0x…>`: Ed25519 over a 32-byte digest by the wallet at `address`, with Privy's hooks as they are when it is called. A Promise, because `PrivySigner` calls it as one: `PrivySigner.of(wallet, (hash) => actions.signRawHash(wallet.address, hash))`. |
| `.logout` | `Effect<void, PrivyCallFailed>`. |
| `PrivyCallFailed` | `Schema.TaggedError`: `call` (`createSuiWallet`, `identityToken` or `logout`) and `cause`. |
| `PrivyActionsCallbacks`, `PrivySession` | Types: of `callbacks`, and of `session`. |
| `useSignIn(actions, options)` | `SignIn<E>`: the sign-in screen's state machine (below). |
| `SignInActions<E, R>` | The app's own operations: `{ sendCode(email), signInWithCode(code), signInWith(provider) }`, each an `Effect<void, E, R>`. Route them however the app does (a service, a context). `E` is tagged (`_tag`): the package's `PrivyFailure`s or the app's own errors. A failure tagged `WrongCode` is the code field's. `signInWithCode` succeeds once the person is signed in (the screen's work is done); `signInWith` succeeds as the page leaves. |
| `UseSignInOptions<R>` | `{ run, returning?, isEmail?, onWrongCode? }`. `run` runs the screen's programs and must start them at once (`Effect.runFork`, or the app runtime's `runFork`). `returning`: the provider Privy is finishing a return from (its button busy, every command ignored). `isEmail`: the app's check of an address (by default `isEmailAddress`). `onWrongCode`: Privy refused the code, and the field has been emptied (focus it). |
| `RunSignIn<R>` | Type of `run`: `(effect: Effect<void, never, R>) => Fiber`. |
| `CODE_LENGTH`, `RESEND_SECONDS` | `6`, `30`. |
| `isEmailAddress(email)` | Whether `email` is an address as `<input type="email">` accepts one (the HTML standard's check). |
| `SignInFlowState<E>`, `SentCode`, `ShownFailure<E>` | Types: the screen's state (one of six, [below](#the-flow-as-states)), `{ to, resendIn }`, `{ from: 'send' \| 'code' \| 'oauth', error }`. |
| `EmailProblem`, `SignInStep`, `TaggedFailure`, `WrongCodeOf<E>` | Types: `'Missing' \| 'Malformed'`, `'email' \| 'code'`, `{ _tag }`, the `WrongCode` members of `E`. |

`SignIn<E>`, for one render:

| Field | What |
| --- | --- |
| `state` | `SignInFlowState<E>`: the flow's state itself (`_tag`: `Email`, `Sending`, `Code`, `Resending`, `Checking` or `Leaving`). The fields below are read from it. |
| `step` | `'email'` (the email, Google, Apple) or `'code'` (the code sent to it). |
| `email`, `setEmail(email)` | The email as typed. Typing clears `emailProblem` and a send's failure. Taken while `state` is `Email`. |
| `emailProblem` | `Option<EmailProblem>`: the trimmed email was missing or not an address on `submitEmail`; nothing was sent. Shown until the email changes. |
| `submitEmail()` | Sends a code to the trimmed email, once it is an address. Then `step` is `'code'` and the resend countdown starts. The address the last code went to, less than the resend wait ago, gets no other: that code stands, and the code step shows again. |
| `sentTo` | `Option<string>`: the address the code went to (trimmed). Say this one in "the code sent to…". |
| `code`, `setCode(code)` | The code as typed. Typing clears the failure shown. Taken while `state` is `Code`. |
| `submitCode(code?)` | Signs in with `code` (by default the one typed) once it has `codeLength` digits. A `WrongCode` failure empties the code and calls `onWrongCode`. An accepted code is spent: the code is emptied and `resendIn` is `0`. |
| `codeLength` | `6`. |
| `resendIn`, `resend()` | Seconds until another code can be sent (`30` after each send, down by `Clock` each second; `0`: now), and sending it. |
| `differentEmail()` | Back to the email step, the code and the failure cleared, the email kept. |
| `continueWith(provider)` | Leaves for Google or Apple. Its button stays busy once `signInWith` succeeds, until the page leaves, or comes back from the back/forward cache. |
| `startOver()` | Back to the email step with nothing showing, the email kept: also from a page that never left for the provider. |
| `sending`, `checking` | A code is being sent; the code is being checked. |
| `provider` | `Option<OAuthProvider>`: the provider whose button is busy (leaving for it, or `returning`). |
| `busy` | Anything runs, or Privy is finishing a return: every command waits (is ignored). |
| `codeFailure` | `Option<WrongCodeOf<E>>`: shown by the code field, as its error. |
| `alert` | `Option<Exclude<E, WrongCode>>`: any other failure, for the screen's alert line. Starting anything clears it. Add the app's own outside failure after it (e.g. an OAuth return that failed: `Option.getOrUndefined(signIn.alert) ?? returnError`). |

### `@misofm/privy-auth/ui`

Unstyled parts (ui-sdk `@ui-sdk/react` and `@ui-sdk/core` `0.1.0-beta.17` are peers, exact). Each
takes `className`, and `classNames` for its inner elements; words are props with defaults. Each app
lays them out and styles them.

| Export | What |
| --- | --- |
| `EmailField` | ui-sdk `Field` + `FieldLabel` + `Input` + `FieldError`: an email input (`type`, `name` and `autocomplete` `email`, the email keyboard, no capitals, no spell check). `value`, `onValueChange`; `label` ("Email"); `labelPlacement` `'above'` (default) or `'inside'` (the label after the input inside `classNames.box`, `placeholder=" "`: float it with `peer-[:placeholder-shown]`); `validation` `'flow'` (default: `problem` is `useSignIn`'s `emailProblem`, the form `noValidate`) or `'native'` (`required`; the browser checks, and ui-sdk shows its errors in place of its bubble); `messages` (`missing`: "Enter your email address.", `malformed`: "Enter an email address like name@example.com."); `classNames` `{ root, box, label, input, error }`. Other props go to the input (`disabled`, `readOnly`, `enterKeyHint`…). |
| `CodeField` | ui-sdk `Field` + `OTPInput`: one native input (`autocomplete="one-time-code"`, numeric, digits only) drawn as `length` (6) slots. `value`, `onValueChange`, `onValueCommit` (every slot filled: pass `submitCode`); `label` ("Code"; hide it with its class); `description` (read with the field); `error` (the field invalid, this its `FieldError`); `controller`; `classNames` `{ root, label, description, input, group, slot, error }`. Other props go to `OTPInput` (`autoFocus`, `readOnly`, `textAlign`…). Slots carry ui-sdk's `data-active`, `data-fake-caret`, `data-disabled`. |
| `createCodeFieldController()` | A handle to focus a `CodeField` (`onWrongCode: () => controller.focus()`). |
| `OAuthButton` | A native button: the provider's mark and "Continue with Google" / "Continue with Apple" (`label`). `busy` shows `spinner` in place of the mark (`busyLabel={false}`: in place of everything), sets `aria-busy` and `data-busy`, and disables it. `className` may be a function of `{ busy, disabled }`; `classNames.mark`. `data-provider` names it. Other props go to the button. |
| `GoogleMark`, `AppleMark` | The official marks, inline SVG (`aria-hidden`): Google's four-colour "G" (20 px), Apple's logo in `currentColor` (18 × 20 px). SVG props override. |
| `OrSeparator` | "or" (`label`) between two decorative ui-sdk `Separator`s. `className`, `classNames.line`. |
| `ConsentLine` | "By signing in, you agree to our Terms of Use and acknowledge our Privacy Policy.", each link to miso.fm in a new tab (`rel="noopener noreferrer"`). `className`, `classNames.link`, `copy` (`agree`, `terms`, `acknowledge`, `privacy`). |
| `TERMS_OF_USE_URL`, `PRIVACY_POLICY_URL` | `https://miso.fm/terms-of-use/`, `https://miso.fm/privacy-policy/`. |
| `EmailFieldProps`, `EmailMessages`, `CodeFieldProps`, `OAuthButtonProps`, `OAuthButtonState`, `ConsentCopy` | Types. |

## The flow, as states

Two state machines, one behind each hook. Each is in exactly one state at a time, and an event a
state has no use for changes nothing.

### Privy's session: `usePrivyActions().session`

| State | When | Then |
| --- | --- | --- |
| `Loading` | Privy hasn't loaded. | Any of the others, once it has. |
| `SignedOut` | Loaded, and no one is signed in. | `SigningIn`, when Privy reports a sign-in. |
| `SigningIn` | Privy has finished a sign-in (it reported one, or says `authenticated`) that its hooks don't show whole yet. The wallet doesn't sign yet. | `SignedIn` at the render that shows the user; `SignedOut` on a sign-out. |
| `SignedIn` (`user`) | `ready`, `authenticated`, and the user named: Privy's hooks act for `user`. | `SignedOut`. |

`onComplete(user)` is called once `SignedIn` shows the user of a sign-in Privy reported, once per
sign-in (a code accepted for the user already signed in is one too).
`loginWithCode` succeeds after it; `createSuiWallet` succeeds once `SignedIn`'s user lists the
wallet. So what follows either can sign at once.

### The sign-in screen: `useSignIn().state`

`Email` and `Code` take the person's input. `Sending`, `Resending`, `Checking` and `Leaving` wait
on one of the app's actions and take none (`busy`).

| From | Event | To |
| --- | --- | --- |
| `Email` | typing | `Email` (its problem and a send's failure cleared) |
| | `submitEmail`, no address | `Email`, with `emailProblem` |
| | `submitEmail`, the last code went to it less than 30 s ago | `Code` (that code stands; none sent) |
| | `submitEmail` | `Sending` (runs `sendCode`) |
| | `continueWith` | `Leaving` (runs `signInWith`) |
| `Sending` | sent | `Code`, the 30 s wait begun |
| | failed | `Email`, the failure in `alert` |
| `Code` | typing | `Code` (the failure cleared) |
| | `submitCode`, six digits | `Checking` (runs `signInWithCode`) |
| | `resend`, the wait over | `Resending` (runs `sendCode`) |
| | `differentEmail`, `startOver` | `Email` (the code sent still known) |
| | `continueWith` | `Leaving` |
| `Resending` | sent | `Code`, emptied, the wait begun again |
| | failed | `Code`, the failure in `alert` |
| `Checking` | accepted | `Code`, emptied, the wait over (the code is spent; another can be sent at once) |
| | failed, `WrongCode` | `Code`, emptied, `codeFailure`, `onWrongCode` |
| | failed, anything else | `Code`, the code kept, the failure in `alert` |
| `Leaving` | `signInWith` succeeded | `Leaving`, waiting on the page |
| | failed | `Email`, the failure in `alert` |
| | the page back from the back/forward cache | `Email` |
| | `startOver`, once `signInWith` has succeeded | `Email` |

- An action that ends without an answer (a defect, an interruption) leaves the screen where a
  failure would, with nothing showing.
- A state that waits leaves only by the answer of the one thing it waits on, and that answers
  once. `startOver` from a page that never left stops waiting for it.
- An action that throws as it is made counts as one that ended without an answer.
- Unmounting interrupts what runs. A screen mounted again while it was waiting (React's
  `Activity`, Fast Refresh) takes input again, and its resend wait goes on.
- What follows an accepted code is the product's: the screen is back at an empty code step, so
  the product replaces it or holds it with its own flag while it finishes, and when that fails
  the person can ask for another code at once. Work the product must finish before anyone is
  signed in to it is best done inside `signInWithCode`: the screen is `checking` until it
  answers, and its failure shows.
- `returning` (back from Google or Apple, Privy finishing it) is the product's, beside the
  state: it makes the screen `busy` and starts nothing. The product clears it on `onComplete`,
  on `onError`, or after its own wait.

### Once, waits and retries

| What | Where | How |
| --- | --- | --- |
| One sign-in reported twice by Privy | `usePrivyActions` | `onComplete` once per sign-in: each accepted code (also for the user already signed in), each return from Google or Apple, a kept sign-in found on load. |
| Signing right after a sign-in, or a wallet just made | `usePrivyActions` | Each step ends once Privy's hooks act on it (10 s at most, then it fails). |
| Two wallets for one account | `createSuiWallet` | None made when the signed-in user has one; calls made together share one request; a wallet Privy answered isn't asked for again. So trying it again is safe. (Privy's own request carries no idempotency key: a wallet made whose answer never arrived can't be known here.) |
| A second tap, a form submitted twice | `useSignIn` | A state that waits takes no command. |
| A code asked for again too soon | `useSignIn` | 30 s for the address the last code went to, through "a different email" too. Over once that code is accepted. |
| The JWKS not answering | `PrivyKeys.makeJwks` | Tried again twice (no answer, 5xx, 429), one fetch shared, at most one refetch a minute, and the keys already read kept meanwhile. |
| `sendCode` or `loginWithCode` failing | no one | Not tried again by itself: each try is an email, or one of a code's few tries. The person does. |
| `refreshIdentityToken` unreachable | the product | Try again on a schedule unless `isSignedOutRefresh(failure.cause)`; ask again until `namesWallet(token, address)` after a wallet is made. |
| How long a step may take, an OAuth return that never finishes | the product | Its own timeouts (`Effect.timeoutOrElse` on its actions; `returning` cleared after a wait). |

## Design: what lives where

- **In the package:** facts about Privy that hold for every app. That covers how it lists the Sui
  wallet and encodes its key, the identity token's claims, its error codes, the OAuth return
  parameters, the config that keeps Privy's UI and wallets out, signing a digest as a Sui `Signer`,
  verifying tokens on a server, Privy's hooks and their quirks (`usePrivyActions`: when its hooks
  act for a sign-in or a wallet, one sign-in heard once), and the sign-in screen's behaviour: its
  states, what is busy, where each failure shows, the resend wait (`useSignIn`), and its unstyled
  parts (`/ui`).
- **In each app:** everything about how the app looks and what it does around sign-in. That
  includes the screen's layout, styles and words, the `PrivyProvider` mount and when it loads, the
  flows (wallet creation, refresh, retries, sign-out), how the screen's actions are routed and run,
  the app's own error types and every sentence the person sees, and its API session.
  `privyFailure` returns the package's errors, which each app maps onto its own.
- **Bundle:** the core never imports `@mysten/sui`, `effect/http` or Privy's runtime, so it can
  sit in an entry chunk next to the app's own `effect`. The fan app keeps the Sui SDK out of its
  entry by importing `@misofm/privy-auth/signer` lazily. `/react` and `/ui` are modules per part
  (`sideEffects: false`): `useSignIn` alone brings no Privy, and `OAuthButton`, the marks and
  `ConsentLine` alone bring no ui-sdk (the fan app's `SignInPending`, in its route tree, uses them).
- **Promises where the SDK wants them:** `PrivySigner` is a `@mysten/sui` `Signer` whose `sign`
  returns a Promise, because the SDK calls it that way. Its typed failure (`InvalidSignature`) is
  thrown as a tagged error.

## Install

```sh
npm install --save-exact @misofm/privy-auth
```

Pin it exactly, as its peers are pinned.

Peer dependencies:

- `effect` `>=4.1.2 <4.2`, required. Use one copy: the app's own.
- `@mysten/sui` `2.38.0`, optional; needed for `/signer` only.
- `@privy-io/react-auth` `3.52.0`, optional; the core's `.d.ts` names `User` and
  `PrivyClientConfig`, and `/react`'s `usePrivyActions` calls its hooks.
- `react` `>=19`, optional; needed for `/react` and `/ui`.
- `@ui-sdk/react` and `@ui-sdk/core` `0.1.0-beta.17` (exact), optional; needed for `/ui`'s fields.

No runtime dependencies.

## Integrating a new product

1. Add the product's origins (production and dev) to the production Privy app's allowed domains.
2. Install `@misofm/privy-auth` (above), `effect` 4.1.x, `react` 19, `@privy-io/react-auth` `3.52.0`
   and `@ui-sdk/react` + `@ui-sdk/core` `0.1.0-beta.17`, plus `@mysten/sui` `2.38.0` if the
   product signs.
3. Mount `PrivyProvider` with `appId` from the build config and
   `config={privyConfig({ theme, accentColor })}`. Inside it, call `usePrivyActions` once, where
   Google or Apple return (check with `oauthReturnPending(location.search)`). Never `useLogin`.
4. In `onComplete(user)`, read the wallet with `suiWallet(user.linkedAccounts)`. If it succeeds
   with `None`, make it: `actions.createSuiWallet`. Privy doesn't make it for a headless sign-in.
   `InvalidSuiWallet` means the account can't sign: say so and sign out. `onComplete` comes once
   Privy's hooks act for the user, so nothing here needs to wait for `ready` or `authenticated`;
   elsewhere, read `actions.session`.
5. Sign with `PrivySigner.of(wallet, (hash) => actions.signRawHash(wallet.address, hash))`, from
   `onComplete` on, and straight after `createSuiWallet` answers.
6. Map the `PrivyFailure`s onto the product's own errors and words, e.g. with
   `Match.tagsExhaustive` or a `switch` on `_tag`. Keep a refused code as a `WrongCode` (the
   package's, or one of the product's with that tag) so the screen puts it on the code field.
7. Use `actions.refreshIdentityToken` only once `namesWallet(token, address)` holds, and refresh
   before `jwtEnd(token)`. If it fails and `isSignedOutRefresh(failure.cause)`, the sign-in is over.
8. On the server, make `PrivyKeys.makeJwks(appId)` once and run
   `verifyIdentityToken(bearer, { appId })` with it. Map `InvalidIdentityToken` to "not signed
   in" and `PrivyKeysUnavailable` to "try again".

### Building the sign-in screen

The screen is the product's own component: its layout, its styles, its words. The flow and the
parts come from here.

```tsx
import { Effect, Option } from 'effect';
import { useState } from 'react';
import type { WrongCode } from '@misofm/privy-auth';
import { type PrivyActions, type SignInActions, useSignIn } from '@misofm/privy-auth/react';
import { CodeField, ConsentLine, createCodeFieldController, EmailField, OAuthButton, OrSeparator } from '@misofm/privy-auth/ui';

// The product's own operations (here straight onto usePrivyActions, which a context hands over).
// Each fails with the product's errors (`MyError`, `toMyError`, `sentenceOf` are the product's),
// a refused code still the package's `WrongCode`.
const actionsOf = (privy: PrivyActions): SignInActions<MyError | WrongCode> => ({
  sendCode: (email) => privy.sendCode(email).pipe(Effect.mapError(toMyError)),
  signInWithCode: (code) => privy.loginWithCode(code).pipe(Effect.mapError((e) => (e._tag === 'WrongCode' ? e : toMyError(e)))),
  signInWith: (provider) => privy.initOAuth(provider).pipe(Effect.mapError(toMyError)),
});

function SignIn({ actions }: { actions: SignInActions<MyError | WrongCode> }) {
  const [codeField] = useState(createCodeFieldController);
  const signIn = useSignIn(actions, { run: Effect.runFork, onWrongCode: () => codeField.focus() });
  const alert = Option.getOrUndefined(signIn.alert);
  return (
    <section>
      {alert && <p role="alert">{sentenceOf(alert)}</p>}
      {signIn.step === 'email' ? (
        <>
          <form noValidate onSubmit={(e) => (e.preventDefault(), signIn.submitEmail())}>
            <EmailField value={signIn.email} onValueChange={signIn.setEmail} problem={signIn.emailProblem} readOnly={signIn.sending} classNames={{ input: '…', error: '…' }} />
            <button type="submit" disabled={signIn.busy}>Continue</button>
          </form>
          <OrSeparator className="…" classNames={{ line: '…' }} />
          {(['google', 'apple'] as const).map((provider) => (
            <OAuthButton key={provider} provider={provider} busy={Option.contains(signIn.provider, provider)} disabled={signIn.busy} onClick={() => signIn.continueWith(provider)} spinner={<Spinner />} className="…" />
          ))}
        </>
      ) : (
        <form noValidate onSubmit={(e) => (e.preventDefault(), signIn.submitCode())}>
          <CodeField value={signIn.code} onValueChange={signIn.setCode} onValueCommit={signIn.submitCode} controller={codeField} autoFocus readOnly={signIn.checking}
            description={`Enter the 6-digit code sent to ${Option.getOrElse(signIn.sentTo, () => '')}`} error={Option.isSome(signIn.codeFailure) ? 'That code didn’t work.' : undefined} classNames={{ slot: '…' }} />
          <button type="submit" disabled={signIn.busy || signIn.code.length !== signIn.codeLength}>Sign in</button>
          <button type="button" disabled={signIn.busy || signIn.resendIn > 0} onClick={signIn.resend}>
            {signIn.resendIn > 0 ? `Resend code (${signIn.resendIn} s)` : 'Resend code'}
          </button>
          <button type="button" disabled={signIn.busy} onClick={signIn.differentEmail}>Use a different email</button>
        </form>
      )}
      <ConsentLine className="…" classNames={{ link: '…' }} />
    </section>
  );
}
```

- `run` is how the product runs Effects: `Effect.runFork` when the actions need nothing, the app
  runtime's `runFork` when they need its services (`SignInActions<E, R>`, `RunSignIn<R>`).
- Show `alert` in one line above the form and `codeFailure` only through `CodeField`'s `error`
  (ui-sdk announces it; no `role="alert"` on it). A product's own outside failure (an OAuth
  return that failed) goes after `alert`.
- Back from Google or Apple (`oauthReturnPending`), pass `returning: provider` to keep that
  button busy while Privy finishes, or show a "Signing in…" state in place of the form.
- Once the code is accepted the screen's part is done, and it shows an empty code step: replace
  it, or say "Signing in…" and disable it, while the product finishes (the wallet, its session).
  If that fails, say why; the person can ask for another code at once. A product whose
  `signInWithCode` does all of it (as the fan app's does) never sees the gap: the screen is
  `checking` until it is done, and a failure shows in `alert`.
- The fan app (app-v2, `src/components/auth/sign-in-panel.tsx`) and Studio (studio-v2,
  `src/auth/SignIn.tsx`) are the two references: the label inside the box with the browser's own
  validation, and the label above with the flow's.

## Develop

```sh
bun install
bun run test       # bun test --coverage
bun run typecheck  # tsc --noEmit, tests included
bun run build      # tsc -p tsconfig.build.json → dist/ (ESM + .d.ts)
bun run pack       # build + dist-pack/misofm-privy-auth.tgz
```
