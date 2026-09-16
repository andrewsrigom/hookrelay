import { useEffect, useState } from 'react';
import { CheckCheck, RotateCw, TriangleAlert, Clock3, WifiOff } from 'lucide-react';
import { api, message } from '../api.js';

type Mode = 'success' | 'flaky' | 'failure' | 'slow' | 'lost-ack';

interface Control {
  id: string;
  mode: Mode;
}

const presets = [
  { id: 'communications', name: 'Customer communications' },
  { id: 'warehouse', name: 'Warehouse sync' },
  { id: 'analytics', name: 'Sales analytics' },
];

const modes = [
  { id: 'success', name: 'Always accept', description: 'Returns HTTP 200.', icon: CheckCheck },
  {
    id: 'flaky',
    name: 'Fail twice',
    description: 'Returns 503 twice, then 200.',
    icon: RotateCw,
  },
  {
    id: 'failure',
    name: 'Always fail',
    description: 'Returns HTTP 503 on every attempt.',
    icon: TriangleAlert,
  },
  {
    id: 'slow',
    name: 'Slow response',
    description: 'Responds after 10 seconds.',
    icon: Clock3,
  },
  {
    id: 'lost-ack',
    name: 'Drop first reply',
    description: 'Saves the action, drops the reply, then accepts the retry.',
    icon: WifiOff,
  },
];

export function Receiver({
  origin,
  notify,
}: {
  origin?: string;
  notify: (message: string, error?: boolean) => void;
}) {
  const [controls, setControls] = useState<Control[]>([]);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!origin) {
      return;
    }

    const controller = new AbortController();
    void api<{ controls: Control[] }>('/receiver', 'GET', undefined, controller.signal)
      .then((data) => setControls(data.controls))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(message(error));
        }
      });

    return () => controller.abort();
  }, [origin]);
  const change = async (id: string, mode: Mode) => {
    setPending(id);
    setError('');
    try {
      await api('/receiver', 'PUT', { id, mode });
      setControls((current) => [...current.filter((item) => item.id !== id), { id, mode }]);
      notify('Receiver response updated.');
    } catch (error) {
      setError(message(error));
    } finally {
      setPending('');
    }
  };

  if (!origin) {
    return (
      <section className="panel guide-section">
        <h2>Local receiver</h2>
        <p>
          Run the local server to use these receivers. On AWS, register an HTTPS URL you control.
        </p>
      </section>
    );
  }

  return (
    <>
      <p className="receiver-intro">
        Set each endpoint's HTTP response, then inspect retries and replay.
      </p>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="receiver-grid">
        {presets.map((preset) => (
          <section className="panel receiver-card" key={preset.id}>
            <h2>{preset.name}</h2>
            <code>
              {origin}/hooks/{preset.id}
            </code>
            <div className="mode-options">
              {modes.map((mode) => (
                <button
                  key={mode.id}
                  className={`mode-option ${controls.find((control) => control.id === preset.id)?.mode === mode.id ? 'selected' : ''}`}
                  disabled={Boolean(pending)}
                  onClick={() => {
                    void change(preset.id, mode.id as Mode);
                  }}
                  aria-pressed={
                    controls.find((control) => control.id === preset.id)?.mode === mode.id
                  }
                >
                  <mode.icon size={18} />
                  <span>
                    <strong>{mode.name}</strong>
                    <small>{mode.description}</small>
                  </span>
                  <span className="radio-dot" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="info-note">
        <RotateCw size={19} />
        <div>
          <strong>Changes apply to the next request.</strong>
          <p>
            To recover a failed delivery, select “Always accept” and replay it from the delivery
            history.
          </p>
        </div>
      </div>
    </>
  );
}
