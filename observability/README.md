# Rate-limiting observability

Import `dashboard.json` into Grafana with a Prometheus datasource. Load
`alerts.yml` in the Prometheus `rule_files` configuration and configure
Alertmanager routing/receivers. These are deployment assets, not already-live
dashboards or alerts.

Scrape `/metrics` on the API using an admin Bearer credential from a secret
file. Keep the endpoint on a private monitoring network:

```yaml
scrape_configs:
  - job_name: orders-api
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/orders-api-token
    static_configs:
      - targets: ["orders-api:3000"]
rule_files:
  - /etc/prometheus/alerts/orders-rate-limits.yml
```

`orders_rate_limit_decisions_total` labels are `tenant`, `tier`, `mode`, and
`outcome` (`allowed`, `rejected`, `would_reject`, `error`). Tenant labels come
only from provisioned identities, not request headers. Limit provisioned tenant
cardinality and monitoring retention; restrict dashboard access because labels
identify tenants. The duration histogram intentionally omits the tenant label.

The 429 alert requires both >10% rejection ratio and >5 rejections/minute for
five minutes to reduce low-volume noise. Tune thresholds with on-call before
deployment. Log-only alerts identify would-reject rates without labeling them
as actual HTTP 429s. Fail-closed limiter errors generate a separate alert.
