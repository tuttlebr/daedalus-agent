Daedalus Helm Chart

Usage:

- Create or update the Secrets with your envs:

  ```sh
  kubectl create secret generic <release>-daedalus-backend-env --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
  ```

  ```sh
  kubectl create secret generic <release>-daedalus-frontend-env --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
  ```

- Install:

  ```sh
  helm install <release> ./daedalus -n <namespace>
  ```

- Set backend config.yaml via values:

  ```sh
  helm upgrade --install <release> ./daedalus -f values.yaml --set-file backend.config.data=backend/config.yaml
  ```
