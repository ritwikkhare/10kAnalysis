'use client';

import { useEffect, useRef } from 'react';

type TurnstileApi = {
  ready(callback: () => void): void;
  render(container: HTMLElement, options: {
    sitekey: string;
    action: string;
    callback(token: string): void;
    'expired-callback'(): void;
    'error-callback'(): void;
  }): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT_ID = 'filinglens-turnstile-script';

export function TurnstileWidget({
  onToken,
  resetNonce,
}: {
  onToken: (token: string) => void;
  resetNonce: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!sitekey || !container.current) return;
    let cancelled = false;
    const render = () => window.turnstile?.ready(() => {
      if (cancelled || !container.current || widgetId.current) return;
      widgetId.current = window.turnstile!.render(container.current, {
        sitekey,
        action: 'analyze_ticker',
        callback: onToken,
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      });
    });
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (window.turnstile) render();
    else if (existing) existing.addEventListener('load', render, { once: true });
    else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.addEventListener('load', render, { once: true });
      document.head.appendChild(script);
    }
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [onToken, sitekey]);

  useEffect(() => {
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, [resetNonce]);

  if (!sitekey) {
    return <p className="challenge-note">Analysis requests remain disabled until the approved Turnstile site key is configured.</p>;
  }
  return <div className="turnstile-container" ref={container} aria-label="Bot verification" />;
}
