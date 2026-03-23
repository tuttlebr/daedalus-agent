# Helmfile Structure Reference

## Directory Layout

```
nvcf-self-managed-installation/
├── helmfile.d/
│   ├── 000-prepare.yaml.gotmpl     # Validation hooks
│   ├── 01-dependencies.yaml.gotmpl # NATS, Cassandra, OpenBao
│   ├── 02-core.yaml.gotmpl         # NVCF services + ingress
│   └── 03-worker.yaml.gotmpl       # NVCA operator
├── environments/
│   ├── base.yaml                    # Default values (all environments)
│   └── <env-name>.yaml             # Per-environment overrides
├── secrets/
│   └── <env-name>-secrets.yaml     # Sensitive values (registry creds, passwords)
└── global.yaml.gotmpl              # Go template that constructs per-chart values
```

## Gotmpl Files and Their Releases

### 01-dependencies.yaml.gotmpl

| Release | Chart | Namespace | Notes |
|---------|-------|-----------|-------|
| nats | helm-nvcf-nats | nats-system | Messaging |
| openbao-server | helm-nvcf-openbao-server | vault-system | Secrets management, depends on nats |
| cassandra | helm-nvcf-cassandra | cassandra-system | Database |

Uses `<<: *dependency` template inheritance with `release-group: dependencies` label.

### 02-core.yaml.gotmpl

| Release | Chart | Namespace | Label |
|---------|-------|-----------|-------|
| api-keys | helm-nvcf-api-keys | api-keys | services |
| sis | helm-nvcf-sis | sis | services |
| api | helm-nvcf-api | nvcf | services |
| invocation-service | helm-nvcf-invocation-service | nvcf | services |
| grpc-proxy | helm-nvcf-grpc-proxy | nvcf | services |
| ess-api | helm-nvcf-ess-api | ess | services |
| notary-service | helm-nvcf-notary-service | nvcf | services |
| admin-issuer-proxy | helm-admin-token-issuer-proxy | api-keys | (no release-group label) |
| ingress | nvcf-gateway-routes | envoy-gateway-system | ingress |

Uses `inherit: [{template: service}]` for services. `admin-issuer-proxy` and `ingress` have standalone `values:` blocks.

### 03-worker.yaml.gotmpl

| Release | Chart | Namespace | Label |
|---------|-------|-----------|-------|
| nvca-operator | nvca-operator | nvca-operator | workers |

Standalone `values:` block with explicit image path construction.

## Template Inheritance

### `<<: *dependency` (YAML merge)

Used in `01-dependencies.yaml.gotmpl`. Merges the template's properties into the release.

**Gotcha**: YAML merge replaces lists. If you add a `values:` key to the release, it **replaces** the template's `values:` list entirely. You must re-include all template values:

```yaml
# Template defines:
templates:
  dependency: &dependency
    chart: nvcf/helm-nvcf-{{ .Release.Name }}
    values:
      - ../global.yaml.gotmpl
      - ../secrets/{{ requiredEnv "HELMFILE_ENV" }}-secrets.yaml

# When overriding, MUST re-include both:
- name: cassandra
  <<: *dependency
  values:
    - ../global.yaml.gotmpl                                    # Must re-include
    - ../secrets/{{ requiredEnv "HELMFILE_ENV" }}-secrets.yaml  # Must re-include
    - cassandra:                                                # Your override
        resources:
          limits:
            memory: 8192Mi
```

### `inherit` (Helmfile native)

Used in `02-core.yaml.gotmpl`. Helmfile's native inheritance mechanism.

```yaml
- name: api
  version: 1.6.0
  namespace: nvcf
  inherit:
    - template: service
```

When adding `values:` to an inherited release, you also need to re-include the template's values files since `values` is a list that gets replaced.

## Values Precedence

From lowest to highest priority:

1. `environments/base.yaml` -- defaults shared across all environments
2. `environments/<env>.yaml` -- per-environment overrides
3. `global.yaml.gotmpl` -- Go template processing (constructs chart-specific structure)
4. `secrets/<env>-secrets.yaml` -- sensitive values
5. Inline `values:` blocks on releases -- highest precedence

## What global.yaml.gotmpl Passes Through

`global.yaml.gotmpl` reads from `.Values` (the merged environment + env-specific YAML) and constructs chart-specific values. It only passes through keys it explicitly references:

### Cassandra
- `cassandra.replicaCount`
- `cassandra.image.*` (registry, repository)
- `cassandra.migrations.image.*`
- `cassandra.persistence.size`
- `cassandra.nodeSelector` (if `global.nodeSelectors.enabled`)
- `cassandra.global.defaultStorageClass`

### NATS
- `nats.container.image.*`
- `nats.reloader.image.*`
- `nats.natsBox.container.image.*`
- `nats.config.jetstream.fileStore.pvc.storageClassName`
- `nats.podTemplate.merge.spec.nodeSelector` (if enabled)

### OpenBao
- `openbao.migrations.image.*` and `openbao.migrations.env`
- `openbao.injector.image.*`
- `openbao.server.image.*`
- `openbao.server.dataStorage.*`
- Node selectors (if enabled)

### Services (API, SIS, etc.)
- `<service>.image.*` (registry, repository)
- `<service>.nodeSelector` (if enabled)
- `<service>.env.*` (observability settings)

**Not passed through**: `resourcePreset`, `resources`, `imagePullSecrets`, `global.imagePullSecrets`, or any other arbitrary key. These must be set via release inline `values:` blocks.

## Helmfile Selectors

Target specific releases or groups:

```bash
# By release group
HELMFILE_ENV=<env> helmfile --selector release-group=dependencies sync
HELMFILE_ENV=<env> helmfile --selector release-group=services sync
HELMFILE_ENV=<env> helmfile --selector release-group=ingress sync
HELMFILE_ENV=<env> helmfile --selector release-group=workers sync

# By release name
HELMFILE_ENV=<env> helmfile --selector name=cassandra sync
HELMFILE_ENV=<env> helmfile --selector name=admin-issuer-proxy sync

# Template only (dry run)
HELMFILE_ENV=<env> helmfile --selector name=cassandra template

# Destroy a single release
HELMFILE_ENV=<env> helmfile --selector name=cassandra destroy
```

Note: `admin-issuer-proxy` has no `release-group` label. Use `--selector name=admin-issuer-proxy`.
