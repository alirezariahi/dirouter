{{- define "dirouter.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 50 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "dirouter.labels" -}}
app.kubernetes.io/part-of: dirouter
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* selector labels: (dict "ctx" $ "component" "gateway") */}}
{{- define "dirouter.selector" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- end -}}

{{- define "dirouter.image" -}}
{{ .ctx.Values.image.registry }}/{{ .app }}:{{ .ctx.Values.image.tag | default .ctx.Chart.AppVersion }}
{{- end -}}

{{- define "dirouter.host" -}}
{{- $h := index .ctx.Values.hosts .name -}}{{ $h | default (printf "%s.%s" .name .ctx.Values.domain) }}
{{- end -}}

{{- define "dirouter.secretName" -}}
{{ .Values.secrets.existingSecret | default (printf "%s-secrets" (include "dirouter.fullname" .)) }}
{{- end -}}

{{- define "dirouter.valkeyUrl" -}}
{{- if .Values.valkey.enabled -}}redis://{{ include "dirouter.fullname" . }}-valkey:6379{{- else -}}{{ required "valkeyUrl is required (or enable valkey)" .Values.valkeyUrl }}{{- end -}}
{{- end -}}

{{- define "dirouter.containerSecurity" -}}
allowPrivilegeEscalation: false
capabilities: { drop: [ALL] }
{{- end -}}

{{/* Secret environment, only the names a service needs: (dict "ctx" $ "names" (list ...)). */}}
{{- define "dirouter.secretEnv" -}}
{{- $s := include "dirouter.secretName" .ctx -}}
{{- range $name := .names }}
- name: {{ $name }}
  valueFrom: { secretKeyRef: { name: {{ $s }}, key: {{ $name }} } }
{{- end }}
{{- end -}}

{{- define "dirouter.pod" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets: {{ toYaml . | nindent 2 }}
{{- end }}
securityContext: {{ toYaml .Values.podSecurityContext | nindent 2 }}
{{- with .Values.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity: {{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
