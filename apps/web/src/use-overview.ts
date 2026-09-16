import { useEffect, useState } from 'react';
import { api, type OverviewData } from './api.js';

export function useOverview(revision: number) {
  const [data, setData] = useState<OverviewData>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.hidden) {
        return;
      }
      pending = true;
      try {
        const next = await api<OverviewData>('/overview', 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) {
          setData(next);
          setError(undefined);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(error);
        }
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 1500);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [revision]);

  return { data, error };
}
