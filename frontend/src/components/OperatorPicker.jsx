import { useEffect, useState } from 'react';
import { getOperator, knownOperator, onOperatorChange, setOperator } from '../operator.js';

/** Current self-declared operator (re-renders when it changes). */
export function useOperator() {
  const [op, setOp] = useState(getOperator());
  useEffect(() => {
    const off = onOperatorChange(setOp);
    setOp(getOperator()); // a change made between the first render and subscribing is not missed
    return off;
  }, []);
  return op;
}

/** Compact selector for the top bar. */
export function OperatorSelect({ teamMembers }) {
  const op = useOperator();
  return (
    <label className="operator-select" title="Self-declared: the team shares one login, so this is not a verified identity.">
      <span className="muted small">Operator</span>
      <select value={op || ''} onChange={(e) => setOperator(e.target.value || null)} aria-label="Operator (self-declared)">
        <option value="">Choose…</option>
        {teamMembers.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <span className="badge" title="Chosen by the person using this browser; not verified">self-declared</span>
    </label>
  );
}

/** Shown once per browser session when the shared database is in use and nobody is chosen yet. */
export function OperatorPrompt({ teamMembers }) {
  const op = useOperator();
  const [choice, setChoice] = useState('');
  // Only a name the server accepts counts: an old or unknown stored name asks again.
  if (knownOperator(op, teamMembers)) return null;
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operator-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (choice) setOperator(choice);
        }}
      >
        <h3 id="operator-title">Who is using this browser?</h3>
        <div className="modal-body">
          <p>
            The team shares one login, so please choose your name. It is recorded with the emails you send and the changes you make, so both of you
            can see who did what.
          </p>
          <p className="muted small">
            This is <strong>self-declared</strong>: it is not a verified identity, and it is not worked out from your IP address, browser or device. You can
            change it at any time at the top of the page.
          </p>
          <div className="operator-choices">
            {teamMembers.map((m) => (
              <label key={m} className="operator-choice">
                <input type="radio" name="operator" value={m} checked={choice === m} onChange={() => setChoice(m)} />
                {m}
              </label>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" type="submit" disabled={!choice}>Continue</button>
        </div>
      </form>
    </div>
  );
}
