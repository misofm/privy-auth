import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';

import { isSignedOutRefresh, PrivyFailure, privyFailure, type PrivyStep, WrongCode } from '../src/index.js';

/** A Privy error as its SDK throws one. */
const privyError = (privyErrorCode: string, status?: number) => Object.assign(new Error(privyErrorCode), { privyErrorCode, ...(status ? { status } : {}) });
const tag = (cause: unknown, step: PrivyStep) => privyFailure(cause, step)._tag;

describe('privyFailure', () => {
  test('a refused code is WrongCode only when checking a code, carrying Privy’s code and the cause', () => {
    const cause = privyError('invalid_credentials');
    const failure = privyFailure(cause, 'loginWithCode');
    expect(failure).toBeInstanceOf(WrongCode);
    expect(failure).toMatchObject({ _tag: 'WrongCode', code: 'invalid_credentials', cause });
    expect(failure.message).toBe('Privy sign-in failed: WrongCode (invalid_credentials)');
    expect(Schema.is(PrivyFailure)(failure)).toBe(true);
    expect(tag(cause, 'login')).toBe('Refused');
    expect(tag(cause, 'sendCode')).toBe('CodeNotSent');
  });

  test('Privy’s codes, whatever the step', () => {
    for (const step of ['sendCode', 'loginWithCode', 'login'] as const) {
      expect(tag(privyError('oauth_user_denied'), step)).toBe('Cancelled');
      expect(tag(privyError('too_many_requests'), step)).toBe('TooManyTries');
      expect(tag(privyError('disallowed_login_method'), step)).toBe('MethodDisabled');
      expect(tag(privyError('allowlist_rejected'), step)).toBe('NotAllowed');
      expect(tag(privyError('client_request_timeout'), step)).toBe('Unreachable');
    }
  });

  test('the code alone, as the login event’s onError gets it', () => {
    expect(privyFailure('oauth_user_denied', 'login')).toMatchObject({ _tag: 'Cancelled', code: 'oauth_user_denied' });
    expect(tag('allowlist_rejected', 'login')).toBe('NotAllowed');
  });

  test('HTTP 429 asks to wait; a code says more', () => {
    expect(tag({ status: 429 }, 'sendCode')).toBe('TooManyTries');
    expect(tag(privyError('unknown_auth_error', 429), 'login')).toBe('TooManyTries');
    expect(tag(privyError('invalid_credentials', 429), 'loginWithCode')).toBe('WrongCode');
  });

  test('anything else: the step’s own failure, with no code', () => {
    const failure = privyFailure(new Error('captcha'), 'sendCode');
    expect(failure).toMatchObject({ _tag: 'CodeNotSent', code: undefined });
    expect(failure.message).toBe('Privy sign-in failed: CodeNotSent');
    expect(tag(new Error('network'), 'loginWithCode')).toBe('Refused');
    expect(tag(privyError('oauth_unexpected'), 'login')).toBe('Refused');
    expect(tag(undefined, 'login')).toBe('Refused');
    expect(tag({ privyErrorCode: 7 }, 'login')).toBe('Refused');
  });

  test('every failure says what it is', () => {
    for (const code of ['oauth_user_denied', 'too_many_requests', 'disallowed_login_method', 'allowlist_rejected', 'client_request_timeout']) {
      const failure = privyFailure(code, 'login');
      expect(failure.message).toBe(`Privy sign-in failed: ${failure._tag} (${code})`);
    }
    expect(privyFailure('x', 'login').message).toBe('Privy sign-in failed: Refused (x)');
  });
});

describe('isSignedOutRefresh', () => {
  test('401, 403 or an invalid token end the sign-in', () => {
    expect(isSignedOutRefresh({ status: 401 })).toBe(true);
    expect(isSignedOutRefresh(Object.assign(new Error('x'), { status: 403 }))).toBe(true);
    expect(isSignedOutRefresh(privyError('missing_or_invalid_token'))).toBe(true);
    expect(isSignedOutRefresh(privyError('must_be_authenticated'))).toBe(true);
  });

  test('anything else is Privy unreachable', () => {
    expect(isSignedOutRefresh({ status: 500 })).toBe(false);
    expect(isSignedOutRefresh(new TypeError('Failed to fetch'))).toBe(false);
    expect(isSignedOutRefresh('missing_or_invalid_token')).toBe(false);
    expect(isSignedOutRefresh(undefined)).toBe(false);
  });
});
