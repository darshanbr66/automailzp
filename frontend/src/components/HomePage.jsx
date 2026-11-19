import { useState } from 'react';
import LoginForm from './LoginForm.jsx';

/**
 * Sign-in screen: a dark field with one engraved dial (a nod to "Zodiac": twelve
 * divisions, an astrolabe-like ring) and the sign-in form set inside it. The
 * dial's accent arc sweeps while the form is working (connecting, waking the
 * server, signing in). Purely static: rendering it makes no request to the
 * backend (see wakeup.js for when the backend is woken). Fits one viewport.
 */

const BUSY = new Set(['connecting', 'waking', 'signing']);

/** Brand mark: the dial in miniature. */
export function LogoMark({ size = 28 }) {
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="-16 -16 32 32" aria-hidden="true" focusable="false">
      <circle r="13" className="logo-mark-ring" />
      {ticks.map((a) => (
        <line key={a} y1="-13" y2={a % 90 === 0 ? -9.5 : -11} transform={`rotate(${a})`} className="logo-mark-tick" />
      ))}
      <circle r="2.2" className="logo-mark-core" />
      <path d="M0-16.2 1.3-13 0-11.6-1.3-13Z" className="logo-mark-star" />
    </svg>
  );
}

const MINOR = Array.from({ length: 72 }, (_, i) => i * 5);

function Dial({ busy }) {
  return (
    <svg className={`dial${busy ? ' is-busy' : ''}`} viewBox="-320 -320 640 640" aria-hidden="true" focusable="false">
      <circle r="316" className="dial-halo" />
      <g className="dial-turn">
        <circle r="292" className="dial-ring" />
        {MINOR.map((a) => {
          const major = a % 30 === 0;
          return <line key={a} y1="-292" y2={major ? -276 : -285} transform={`rotate(${a})`} className={major ? 'dial-tick-major' : 'dial-tick'} />;
        })}
        <circle r="262" className="dial-inner" />
      </g>
      <g className="dial-sweep">
        {/* Invisible: makes this group's box the full dial, so it turns around the centre. */}
        <circle r="310" fill="none" stroke="none" />
        <path d="M0-292A292 292 0 0 1 146-252.9" className="dial-arc" />
        <path d="M0-305 4-299 0-293-4-299Z" className="dial-star" />
      </g>
    </svg>
  );
}

export default function HomePage({ message, onSignedIn }) {
  const [phase, setPhase] = useState('idle');
  return (
    <div className="lp">
      <header className="lp-brand signin-brand">
        <LogoMark />
        <span className="lp-brand-text">
          <span className="lp-brand-name">ZodiacPatent</span>
          <span className="lp-brand-product">Attorney Email Automation</span>
        </span>
      </header>

      <main className="lp-stage">
        <Dial busy={BUSY.has(phase)} />
        <div className="lp-form home-login">
          <LoginForm message={message} onSignedIn={onSignedIn} variant="stage" onPhaseChange={setPhase} />
        </div>
      </main>
    </div>
  );
}
