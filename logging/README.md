# Log Shipper (`logging/`)

Log shipper / collector configuration for `alsaqi-backend`, implementing the
log-collection side of **Requirement 14** (تجميع السجلات والاحتفاظ بها) from the
`production-launch-readiness` spec. It corresponds to design.md region **(ي‑14)**:

> ناقل سجلات (مثل Promtail→Loki أو Vector) يجمع سجلات `API_Container` خلال 60s،
> يعيد المحاولة 3 مرات ثم يحفظ في عازلة ويُنبّه.

## Why Vector

[Vector](https://vector.dev) was chosen over Promtail because it provides, in one
agent, the three guarantees Req 14.2 demands without external glue:

- **Configurable retry count** — `request.retry_attempts = 3`.
- **Durable buffering that never drops** — `buffer.type = "disk"` with
  `when_full = "block"` (applies back-pressure instead of discarding).
- **Alerting signal** — a built-in `prometheus_exporter` sink that surfaces
  delivery-failure and buffer-growth metrics for Alertmanager to fire on.

The single config file is [`vector.toml`](./vector.toml). The central store it
ships to is Loki (the `Log_Aggregator` in the design).

## Pipeline

```
docker_logs (API_Container)
        │
   parse_json (extract level/traceId, keep raw on parse failure)
        ├──────────────► loki sink         (primary: retry → disk buffer)
        └──────────────► dead_letter_file   (local durable mirror)

internal_metrics ───────► vector_alerts     (prometheus_exporter → Alertmanager)
```

## How the config maps to the acceptance criteria

### Req 14.1 — collect each entry within 60s

- `sources.api_container` (`docker_logs`) tails the running `API_Container`
  continuously, so entries are picked up as soon as they are written.
- `sinks.loki.batch.timeout_secs = 5` forces a flush at least every 5 seconds —
  well under the 60-second collection budget — so a log emitted by the API
  reaches the aggregator promptly.

### Req 14.2 — retry 3×, then buffer without dropping, and alert

| Obligation | Where it is encoded |
|---|---|
| Retry up to 3 times on failure | `sinks.loki.request.retry_attempts = 3` (with bounded backoff) |
| Save to a buffer without dropping | `sinks.loki.buffer`: `type = "disk"`, `when_full = "block"` — a 1 GiB durable on-disk buffer that back-pressures the source instead of discarding events. Survives restarts via `data_dir`. |
| Extra safety net (never drop) | `sinks.dead_letter_file` writes a durable local JSON mirror, also with a blocking disk buffer, so a complete on-host copy exists even during a prolonged outage. |
| Trigger an alert on persistent failure | `sinks.vector_alerts` (`prometheus_exporter`) exposes Vector internals; Prometheus scrapes it and Alertmanager fires when the `loki` sink keeps erroring or its buffer keeps growing. |

Supporting alert rules (to add next to `monitoring/alert.rules.yml`):

```yaml
- alert: LogShipperDeliveryFailing
  expr: rate(vector_component_errors_total{component_id="loki"}[5m]) > 0
  for: 2m
- alert: LogShipperBufferBackingUp
  expr: vector_buffer_events{component_id="loki"} > 0
  for: 5m
```

> Collection + reliable-shipping (Req 14.1, 14.2) live on this shipper (`vector.toml`).
> Retention, deletion, and query behavior (Req 14.3–14.6) are configured on the
> `Log_Aggregator` (Loki) itself in [`loki-config.yml`](./loki-config.yml) — see the
> next section.

## Log_Aggregator (Loki) — retention, deletion & query

The central store the shipper pushes into is **Loki**, configured in
[`loki-config.yml`](./loki-config.yml). It implements the retention/query half of
**Requirement 14** (design region **ي‑14**):

### Req 14.3 — configurable retention, default 365 days, range [90 .. 2555]

Retention is set by `limits_config.retention_period`, driven by the
`LOKI_RETENTION_PERIOD` environment value and **defaulting to `365d`** when unset:

```yaml
retention_period: ${LOKI_RETENTION_PERIOD:-365d}
```

The allowed range is **90 days (`90d`) to 2555 days (`2555d`, ≈ 7 years)**. Loki
does not range-check this value itself, so **clamp it before deploying**:

- Express the value in days with a `d` suffix (e.g. `90d`, `365d`, `2555d`).
- If a requested value is below `90d`, set `90d`; if above `2555d`, set `2555d`.
- Out-of-range or unit-less values must be corrected by the operator/IaC layer
  prior to start — there is no in-config clamp.

Logs stay **queryable for the whole period**: `max_query_lookback` is `0s`
(unbounded) and queries split by day, so any timestamp inside the retention window
is searchable.

### Req 14.4 — delete within 24h of expiry

Deletion is performed by the **compactor** with retention enabled. The delete
delay is held far below the 24-hour ceiling:

```yaml
compactor:
  retention_enabled: true
  compaction_interval: 10m          # act on expiry promptly
  retention_delete_delay: 2h        # well under the 24h budget (Req 14.4)
  retention_delete_worker_count: 150
```

An entry that crosses its retention boundary is picked up on the next 10-minute
compaction cycle and physically removed after the 2-hour delete delay — always
inside the required 24 hours.

### Req 14.5 — query by time-range + `traceId` within 30s

`traceId` is carried in the JSON log body (the shipper guarantees the field always
exists, defaulting to `"unknown"`). Operators query it with a LogQL JSON filter
over a time range, for example:

```logql
{service="alsaqi-api"} | json | traceId="<the-trace-id>"
```

selected over the desired `start`/`end` range. The 30-second budget is enforced
on two layers:

- `querier.query_timeout: 30s` and `limits_config.query_timeout: 30s` cap each query.
- `server.http_server_read_timeout` / `write_timeout: 30s` bound the HTTP request.
- `split_queries_by_interval: 24h` parallelises wide range scans so they finish fast.

`traceId` is intentionally **not** an index label (it is matched from the log line)
to keep label cardinality low; this is the recommended Loki pattern for high-cardinality
correlation ids.

### Req 14.6 — non-matching query returns an empty result set, not an error

LogQL returns an **empty stream** for a selector/filter that matches nothing — it
is not an error condition. No extra configuration is needed; a query such as
`{service="alsaqi-api"} | json | traceId="does-not-exist"` returns `[]` with a
`200`. This behavior is asserted by the verification test in task 18.3.

### Deploying Loki

```yaml
loki:
  image: grafana/loki:3.0.0
  command: -config.file=/etc/loki/loki-config.yml
  volumes:
    - ./logging/loki-config.yml:/etc/loki/loki-config.yml:ro
    - loki_data:/loki                       # persistent: chunks, index, compactor
  environment:
    - LOKI_RETENTION_PERIOD=365d            # any value in [90d .. 2555d]
  ports:
    - "3100:3100"
  networks:
    - alsaqi-network
  restart: unless-stopped
```

The shipper's `LOKI_ENDPOINT` (default `http://loki:3100`) must point at this service.

## Deployment

Run Vector as a sidecar/daemon alongside `API_Container`:

- Mount the Docker socket read-only: `/var/run/docker.sock:/var/run/docker.sock:ro`
  (required by the `docker_logs` source).
- Mount a **persistent** volume at `/var/lib/vector` (`data_dir`) so disk buffers
  and the dead-letter mirror survive restarts — this is what makes "never drop"
  hold across a Vector or host restart.
- Set environment variables:
  - `LOKI_ENDPOINT` — Loki push URL (default `http://loki:3100`).

Example compose service:

```yaml
vector:
  image: timberio/vector:latest-alpine
  volumes:
    - ./logging/vector.toml:/etc/vector/vector.toml:ro
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - vector_data:/var/lib/vector
  environment:
    - LOKI_ENDPOINT=http://loki:3100
  networks:
    - alsaqi-network
  restart: unless-stopped
```

Validate the config locally with:

```bash
vector validate logging/vector.toml
```
