/**
 * supabase.js — Minimal Supabase client for the Chrome extension.
 * This avoids needing a build step by implementing only what we need:
 * - REST API calls (select, insert, upsert)
 * - Realtime via Supabase Realtime WebSocket protocol
 *
 * Exposes: createSupabaseClient(url, key) → client
 */

function createSupabaseClient(supabaseUrl, supabaseKey) {
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  function from(table) {
    let _filters = [];
    let _selectCols = '*';

    const builder = {
      select(cols = '*') {
        _selectCols = cols;
        return builder;
      },
      eq(col, val) {
        _filters.push(`${col}=eq.${encodeURIComponent(val)}`);
        return builder;
      },
      async single() {
        const qs = _filters.length ? '?' + _filters.join('&') : '';
        const url = `${supabaseUrl}/rest/v1/${table}${qs}&select=${_selectCols}`;
        const res = await fetch(url, { headers: { ...headers, 'Accept': 'application/vnd.pgrst.object+json' } });
        const data = await res.json();
        if (!res.ok) return { data: null, error: data };
        return { data, error: null };
      },
      async insert(body) {
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { data: null, error: err };
        }
        return { data: null, error: null };
      },
      async upsert(body, { onConflict } = {}) {
        const url = onConflict
          ? `${supabaseUrl}/rest/v1/${table}?on_conflict=${onConflict}`
          : `${supabaseUrl}/rest/v1/${table}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { data: null, error: err };
        }
        return { data: null, error: null };
      },
      async update(body) {
        const qs = _filters.length ? '?' + _filters.join('&') : '';
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}${qs}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { data: null, error: err };
        }
        return { data: null, error: null };
      }
    };

    return builder;
  }

  // ── Minimal Realtime ───────────────────────────────────────────────────────────
  function channel(name) {
    let ws = null;
    let subscriptions = [];
    let heartbeatInterval = null;

    const ch = {
      on(event, config, callback) {
        subscriptions.push({ event, config, callback });
        return ch;
      },
      subscribe() {
        const wsUrl = supabaseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/realtime/v1/websocket?apikey=' + supabaseKey + '&vsn=1.0.0';

        try {
          ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            // Join channel
            ws.send(JSON.stringify({
              topic: `realtime:${name}`,
              event: 'phx_join',
              payload: {},
              ref: '1'
            }));

            heartbeatInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
              }
            }, 30000);
          };

          ws.onmessage = (e) => {
            try {
              const msg = JSON.parse(e.data);
              if (msg.event === 'postgres_changes') {
                for (const sub of subscriptions) {
                  if (sub.event === 'postgres_changes') {
                    const payload = msg.payload;
                    if (
                      payload.schema === sub.config.schema &&
                      payload.table === sub.config.table
                    ) {
                      // Check event type
                      if (sub.config.event === '*' || sub.config.event === payload.type) {
                        // Check filter if present
                        if (!sub.config.filter || checkFilter(sub.config.filter, payload.record || payload.new)) {
                          sub.callback({ new: payload.record || payload.new, old: payload.old_record });
                        }
                      }
                    }
                  }
                }
              }
            } catch (err) {
              // Ignore parse errors
            }
          };

          ws.onerror = () => {
            clearInterval(heartbeatInterval);
          };
        } catch (err) {
          console.warn('[ActionTracker] Realtime WS error:', err);
        }

        return ch;
      },
      unsubscribe() {
        clearInterval(heartbeatInterval);
        if (ws) ws.close();
      }
    };

    return ch;
  }

  function checkFilter(filterStr, record) {
    // Simple eq filter: "col=eq.val"
    const match = filterStr.match(/^(\w+)=eq\.(.+)$/);
    if (!match) return true;
    return String(record[match[1]]) === match[2];
  }

  return { from, channel };
}
