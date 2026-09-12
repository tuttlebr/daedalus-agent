{{- define "daedalus.name" -}}
{{- default .Chart.Name .Values.global.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "daedalus.fullname" -}}
{{- if .Values.global.fullnameOverride -}}
{{- .Values.global.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.global.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "daedalus.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "daedalus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: Helm
{{- end -}}

{{- define "daedalus.nodePlacement" -}}
{{- $allowedNodes := .Values.global.nodePlacement.allowedNodes -}}
{{- $allowedArchitectures := .allowedArchitectures | default (list) -}}
{{- if or $allowedNodes $allowedArchitectures }}
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
        - matchExpressions:
            {{- if $allowedNodes }}
            - key: kubernetes.io/hostname
              operator: In
              values:
              {{- range $allowedNodes }}
                - {{ . | quote }}
              {{- end }}
            {{- end }}
            {{- if $allowedArchitectures }}
            - key: kubernetes.io/arch
              operator: In
              values:
              {{- range $allowedArchitectures }}
                - {{ . | quote }}
              {{- end }}
            {{- end }}
{{- end }}
{{- end -}}

{{- /*
Render an image by immutable digest when configured, otherwise fall back to
the explicit tag. Call with: include "daedalus.image" .Values.images.backend
*/ -}}
{{- define "daedalus.image" -}}
{{- if .digest -}}
{{- printf "%s@%s" .repository .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}
{{- end -}}

{{- define "daedalus.redisSecretName" -}}
{{- .Values.redis.auth.existingSecret | default (printf "%s-redis-auth" (include "daedalus.fullname" .)) -}}
{{- end -}}

{{- define "daedalus.contentCredentialsEnv" -}}
{{- $c := .Values.contentCredentials -}}
{{- if not (has $c.mode (list "off" "local")) -}}
{{- fail "contentCredentials.mode must be off or local" -}}
{{- end -}}
- name: C2PA_SIGNING_MODE
  value: {{ $c.mode | quote }}
{{- if ne $c.mode "off" }}
{{- $_ := required "contentCredentials.existingSecret is required for signing" $c.existingSecret }}
- name: C2PA_CREATOR_NAME
  value: {{ required "contentCredentials.creatorName is required" $c.creatorName | quote }}
- name: C2PA_CERTIFICATE_FILE
  value: /etc/c2pa/chain.pem
- name: C2PA_SIGNING_ALGORITHM
  value: {{ $c.signingAlgorithm | quote }}
- name: C2PA_PRIVATE_KEY_FILE
  value: /etc/c2pa/key.pem
{{- end }}
{{- end -}}

{{- define "daedalus.contentCredentialsMount" -}}
{{- if ne .Values.contentCredentials.mode "off" -}}
- name: content-credentials
  mountPath: /etc/c2pa
  readOnly: true
{{- end -}}
{{- end -}}

{{- define "daedalus.contentCredentialsVolume" -}}
{{- $c := .Values.contentCredentials -}}
{{- if ne $c.mode "off" -}}
- name: content-credentials
  secret:
    secretName: {{ $c.existingSecret | quote }}
    defaultMode: 0440
    items:
      - key: {{ $c.certificateKey | quote }}
        path: chain.pem
      - key: {{ $c.privateKeyKey | quote }}
        path: key.pem
{{- end -}}
{{- end -}}

{{- define "daedalus.redisTlsSecretName" -}}
{{- required "redis.tls.existingSecret is required when redis.tls.enabled=true" .Values.redis.tls.existingSecret -}}
{{- end -}}

{{- /*
Restart Redis and every in-chart client when Helm-managed ACL values change.
External Secret contents are intentionally opaque to Helm and require the
documented forceRedeploy value during rotation.
*/ -}}
{{- define "daedalus.redisAuthConfigChecksum" -}}
{{- toJson .Values.redis.auth | sha256sum -}}
{{- end -}}

{{- define "daedalus.documentObjectSecretName" -}}
{{- .Values.documentObjectStorage.auth.existingSecret | default (printf "%s-document-objects" (include "daedalus.fullname" .)) -}}
{{- end -}}

{{- define "daedalus.documentObjectNetworkMode" -}}
{{- $mode := .Values.documentObjectStorage.networkPolicy.mode | default "inCluster" -}}
{{- if not (has $mode (list "inCluster" "external")) -}}
{{- fail "documentObjectStorage.networkPolicy.mode must be inCluster or external" -}}
{{- end -}}
{{- $mode -}}
{{- end -}}

{{- define "daedalus.documentObjectRequestTimeoutMs" -}}
{{- $timeout := int (.Values.documentObjectStorage.requestTimeoutMs | default 300000) -}}
{{- if or (lt $timeout 100) (gt $timeout 900000) -}}
{{- fail "documentObjectStorage.requestTimeoutMs must be between 100 and 900000" -}}
{{- end -}}
{{- $timeout -}}
{{- end -}}
