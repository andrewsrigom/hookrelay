import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Cable,
  FlaskConical,
  LayoutDashboard,
  ListFilter,
  Menu,
  Plus,
  Radio,
  X,
} from 'lucide-react';
import { ApiError, message, setAccessKey } from './api.js';
import { useOverview } from './use-overview.js';
import { Overview } from './components/Overview.js';
import { DeliveryTable } from './components/DeliveryTable.js';
import { Endpoints } from './components/Endpoints.js';
import { PublishForm, EndpointForm } from './components/Forms.js';
import { DeliveryDetail } from './components/DeliveryDetail.js';
import { Receiver } from './components/Receiver.js';
import { Guide } from './components/Guide.js';

const pages = {
  overview: {
    title: 'Overview',
    icon: LayoutDashboard,
  },
  deliveries: {
    title: 'Deliveries',
    icon: ListFilter,
  },
  endpoints: {
    title: 'Endpoints',
    icon: Cable,
  },
  receiver: {
    title: 'Test receivers',
    icon: FlaskConical,
  },
  guide: {
    title: 'Integration guide',
    icon: BookOpen,
  },
};

type Page = keyof typeof pages;

function currentPage(): Page {
  const hash = location.hash.slice(1);
  return Object.hasOwn(pages, hash) ? (hash as Page) : 'overview';
}

export function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [revision, setRevision] = useState(0);
  const { data, error } = useOverview(revision);

  const [modal, setModal] = useState<'publish' | 'endpoint'>();
  const [selected, setSelected] = useState<string>();
  const [toast, setToast] = useState<{ message: string; error: boolean }>();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  const navigationButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => {
      setIsMobile(media.matches);
      setMobileMenu(false);
    };
    media.addEventListener('change', update);

    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!mobileMenu || !isMobile) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.querySelector<HTMLAnchorElement>('#workspace-navigation a')?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenu(false);
      }
    };
    window.addEventListener('keydown', close);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', close);
      navigationButton.current?.focus();
    };
  }, [mobileMenu, isMobile]);

  const [key, setKey] = useState('');
  const refresh = () => setRevision((value) => value + 1);
  const notify = (message: string, error = false) => setToast({ message, error });

  useEffect(() => {
    const listener = () => setPage(currentPage());
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = setTimeout(() => setToast(undefined), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const navigate = (next: Page) => {
    location.hash = next;
    setPage(next);
    setMobileMenu(false);
  };

  const metadata = pages[page];
  const failed = data?.deliveries.filter((delivery) => delivery.status === 'failed').length ?? 0;

  return (
    <div className="app-shell">
      {mobileMenu ? (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileMenu(false)}
        />
      ) : null}
      <aside
        id="workspace-navigation"
        inert={isMobile && !mobileMenu}
        className={`sidebar ${mobileMenu ? 'mobile-open' : ''}`}
      >
        <a className="brand" href="#overview" onClick={() => setMobileMenu(false)}>
          <span className="brand-mark">
            <Radio size={25} />
          </span>
          <span>
            hookrelay<span className="brand-period">.</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          {(['overview', 'deliveries', 'endpoints'] as Page[]).map((key) => {
            const Icon = pages[key].icon;
            return (
              <a
                href={`#${key}`}
                key={key}
                className={page === key ? 'active' : ''}
                aria-current={page === key ? 'page' : undefined}
                onClick={() => navigate(key)}
              >
                <Icon size={19} />
                {pages[key].title}
                {key === 'deliveries' && failed ? (
                  <span className="nav-count">{failed}</span>
                ) : null}
              </a>
            );
          })}
        </nav>
        <div className="nav-label tools-label">TOOLS</div>
        <nav aria-label="Tools">
          {(['receiver', 'guide'] as Page[]).map((key) => {
            const Icon = pages[key].icon;
            return (
              <a
                href={`#${key}`}
                key={key}
                className={page === key ? 'active' : ''}
                aria-current={page === key ? 'page' : undefined}
                onClick={() => navigate(key)}
              >
                <Icon size={19} />
                {pages[key].title}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-status">
            <span className={error ? 'status-dot warning-dot' : 'status-dot'} />
            {error ? 'Disconnected' : data ? 'Connected' : 'Connecting…'}
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={isMobile && mobileMenu}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              ref={navigationButton}
              aria-expanded={mobileMenu}
              aria-controls="workspace-navigation"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
          </div>
          <div className="topbar-actions">
            <span className="environment">
              <span className="status-dot" />
              {data?.receiverOrigin ? 'Local runtime' : 'Cloud runtime'}
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>{metadata.title}</h1>
            </div>
            <button className="primary-button" disabled={!data} onClick={() => setModal('publish')}>
              <Plus size={18} />
              Publish event
            </button>
          </div>
          {error ? (
            <div className="connection-error" role="alert">
              {message(error)}{' '}
              <button className="text-button" onClick={refresh}>
                Retry
              </button>
            </div>
          ) : null}
          {error instanceof ApiError && error.status === 401 ? (
            <form
              className="panel auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                setAccessKey(key);
                setKey('');
                refresh();
              }}
            >
              <h2>Connect workspace</h2>
              <label>
                Access key
                <input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  required
                />
              </label>
              <button className="primary-button">Connect</button>
            </form>
          ) : data ? (
            <>
              {page === 'overview' ? (
                <Overview
                  data={data}
                  onSelect={setSelected}
                  onViewAll={() => navigate('deliveries')}
                />
              ) : null}
              {page === 'deliveries' ? (
                <DeliveryTable deliveries={data.deliveries} onSelect={setSelected} />
              ) : null}
              {page === 'endpoints' ? (
                <Endpoints
                  endpoints={data.endpoints}
                  onCreate={() => setModal('endpoint')}
                  onChange={refresh}
                  notify={notify}
                />
              ) : null}
              {page === 'receiver' ? (
                <Receiver origin={data.receiverOrigin} notify={notify} />
              ) : null}
              {page === 'guide' ? <Guide /> : null}
            </>
          ) : (
            <div className="panel loading-state">
              <Radio size={28} />
              <p>Connecting…</p>
            </div>
          )}
        </main>
      </div>
      {modal === 'publish' && data ? (
        <PublishForm
          endpoints={data.endpoints}
          onClose={() => setModal(undefined)}
          onDone={(text) => {
            setModal(undefined);
            notify(text);
            refresh();
          }}
        />
      ) : null}
      {modal === 'endpoint' ? (
        <EndpointForm
          receiverOrigin={data?.receiverOrigin}
          onClose={() => setModal(undefined)}
          onDone={refresh}
        />
      ) : null}
      {selected ? (
        <DeliveryDetail
          key={selected}
          id={selected}
          onClose={() => setSelected(undefined)}
          onReplay={(id) => {
            setSelected(id);
            notify('Replay created. Original delivery history retained.');
            refresh();
          }}
        />
      ) : null}
      {toast ? (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          <span>{toast.message}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast(undefined)}>
            <X size={16} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
