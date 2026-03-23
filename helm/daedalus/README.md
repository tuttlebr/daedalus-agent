# Daedalus Helm Chart

Use this chart to deploy Daedalus with separate default and Deep Thinker backends.

## Prerequisites

You need the following before installing the chart:
- Helm 3.x
- A Kubernetes cluster with access to your container registry
- A `.env` file containing backend and frontend environment variables

## Create or Update Secrets

Create secrets from your `.env` file for the backend and frontend:
```sh
kubectl create secret generic <release>-daedalus-backend-env --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic <release>-daedalus-frontend-env --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
```

## Install or Upgrade

Install or upgrade the chart:
```sh
helm upgrade --install <release> ./daedalus -n <namespace>
```

## Override Backend Configurations

Set backend config files through Helm values:
```sh
helm upgrade --install <release> ./daedalus -n <namespace> \
  --set-file backend.default.config.data=backend/tool-calling-config.yaml \
  --set-file backend.deepThinker.config.data=backend/react-agent-config.yaml
```

## Values Reference

Default values live in `values.yaml`. Update them to adjust images, persistence, ingress, or enable and disable the default and Deep Thinker backends.
