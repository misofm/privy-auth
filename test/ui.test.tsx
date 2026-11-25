
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Option } from 'effect';

import { AppleMark, CodeField, ConsentLine, createCodeFieldController, EmailField, GoogleMark, OAuthButton, OrSeparator } from '../src/ui.js';

afterEach(() => cleanup());

/** Types into a native input as a person would: React and ui-sdk hear its `input` event. */
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('EmailField', () => {
  test('an email input named by its label above it; the flow’s problems as its error', () => {
    const changed = mock((_: string) => {});
    const { container, rerender } = render(<EmailField value="" onValueChange={changed} classNames={{ root: 'root', label: 'label', input: 'input', error: 'error' }} />);
    const input = container.querySelector('input')!;
    expect([input.type, input.name, input.autocomplete, input.inputMode, input.getAttribute('autocapitalize'), input.getAttribute('spellcheck'), input.required, input.placeholder]).toEqual([
      'email',
      'email',
      'email',
      'email',
      'none',
      'false',
      false,
      '',
    ]);
    expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Email');
    expect(container.firstElementChild?.className).toBe('root');
    expect(container.querySelector('label')?.nextElementSibling).toBe(input);
    type(input, 'a');
    expect(changed).toHaveBeenLastCalledWith('a');
    rerender(<EmailField value="" onValueChange={changed} problem={Option.some('Missing')} />);
    expect(container.textContent).toContain('Enter your email address.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    rerender(<EmailField value="a" onValueChange={changed} problem={Option.some('Malformed')} messages={{ malformed: 'Enter your email address.' }} />);
    expect(container.textContent).toContain('Enter your email address.');
    rerender(<EmailField value="a" onValueChange={changed} problem={Option.some('Malformed')} />);
    expect(container.textContent).toContain('Enter an email address like name@example.com.');
  });

  test('the label inside the box; the browser’s own validation', () => {
    const { container } = render(<EmailField value="" onValueChange={() => {}} labelPlacement="inside" validation="native" label="Your email" enterKeyHint="go" classNames={{ box: 'box' }} />);
    const input = container.querySelector('input')!;
    expect(input.parentElement?.className).toBe('box');
    expect(input.nextElementSibling?.textContent).toBe('Your email');
    expect([input.required, input.placeholder, input.getAttribute('enterkeyhint')]).toEqual([true, ' ', 'go']);
  });
});

describe('CodeField', () => {
  test('one-time code slots, its label and description; an error marks it invalid', () => {
    const committed = mock((_: string) => {});
    const controller = createCodeFieldController();
    const { container, rerender } = render(
      <CodeField value="" onValueChange={() => {}} onValueCommit={committed} controller={controller} description="Enter the code" classNames={{ slot: 'slot', group: 'group' }} />,
    );
    const input = container.querySelector('input')!;
    expect([input.autocomplete, input.inputMode, input.maxLength]).toEqual(['one-time-code', 'numeric', 6]);
    expect(container.querySelectorAll('.slot').length).toBe(6);
    expect(container.textContent).toContain('Enter the code');
    expect(container.querySelector('label')?.textContent).toBe('Code');
    act(() => controller.focus());
    expect(document.activeElement).toBe(input);
    rerender(<CodeField value="" onValueChange={() => {}} length={4} label="4-digit code" error="That code didn’t work." />);
    expect(container.querySelector('input')?.maxLength).toBe(4);
    expect(container.querySelector('input')?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('That code didn’t work.');
  });
});

describe('OAuthButton', () => {
  test('the mark and the provider’s wording; busy: the spinner, the label kept or not', () => {
    const pressed = mock(() => {});
    const { container, rerender } = render(<OAuthButton provider="google" onClick={pressed} className={({ busy, disabled }) => `b${busy ? ' busy' : ''}${disabled ? ' off' : ''}`} classNames={{ mark: 'mark' }} />);
    const button = container.querySelector('button')!;
    expect([button.type, button.textContent, button.className, button.dataset.provider, button.disabled, button.getAttribute('aria-busy')]).toEqual(['button', 'Continue with Google', 'b', 'google', false, null]);
    expect(button.querySelector('svg')?.getAttribute('class')).toBe('mark');
    fireEvent.click(button);
    expect(pressed).toHaveBeenCalledTimes(1);
    rerender(<OAuthButton provider="apple" busy spinner={<i>spin</i>} className="static" />);
    expect([button.textContent, button.className, button.disabled, button.getAttribute('aria-busy'), button.querySelector('svg')]).toEqual(['spinContinue with Apple', 'static', true, 'true', null]);
    rerender(<OAuthButton provider="apple" busy busyLabel={false} spinner={<i>spin</i>} label="Apple" />);
    expect(button.textContent).toBe('spin');
    rerender(<OAuthButton provider="apple" disabled label="Apple" />);
    expect([button.textContent, button.disabled]).toEqual(['Apple', true]);
  });

  test('the marks take SVG props', () => {
    const { container } = render(
      <>
        <GoogleMark className="g" width={16} />
        <AppleMark />
      </>,
    );
    const [google, apple] = [...container.querySelectorAll('svg')];
    expect([google?.getAttribute('class'), google?.getAttribute('width'), google?.getAttribute('aria-hidden')]).toEqual(['g', '16', 'true']);
    expect([apple?.getAttribute('width'), apple?.getAttribute('fill')]).toEqual(['18', 'currentColor']);
  });
});

describe('OrSeparator and ConsentLine', () => {
  test('“or” between two decorative lines', () => {
    const { container } = render(<OrSeparator className="row" classNames={{ line: 'line' }} />);
    expect(container.firstElementChild?.className).toBe('row');
    expect(container.textContent).toBe('or');
    expect(container.querySelectorAll('.line').length).toBe(2);
  });

  test('the Terms of Use and the Privacy Policy, each in a new tab; its words', () => {
    const { container, rerender } = render(<ConsentLine className="consent" classNames={{ link: 'link' }} />);
    expect(container.textContent).toBe('By signing in, you agree to our Terms of Use and acknowledge our Privacy Policy.');
    expect([...container.querySelectorAll('a')].map((a) => [a.textContent, a.href, a.target, a.rel, a.className])).toEqual([
      ['Terms of Use', 'https://miso.fm/terms-of-use/', '_blank', 'noopener noreferrer', 'link'],
      ['Privacy Policy', 'https://miso.fm/privacy-policy/', '_blank', 'noopener noreferrer', 'link'],
    ]);
    rerender(<ConsentLine copy={{ agree: 'Signing in, you accept our' }} />);
    expect(container.textContent).toStartWith('Signing in, you accept our Terms of Use');
  });
});
