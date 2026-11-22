variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-2"
}

variable "container_port" {
  description = "Port the app listens on inside the container"
  type        = number
  default     = 8080
}

variable "desired_count" {
  description = "Running ECS tasks. Keep 0 until an image is pushed and Cognito is wired (Phase 4)."
  type        = number
  default     = 0
}

variable "ui_callback_urls" {
  description = "Where Cognito may send users back after login/logout. Must match OAUTH_SIGN_IN_REDIRECT_URL in fragments-ui exactly."
  type        = list(string)
  default     = ["http://localhost:1234"]
}

variable "github_repo" {
  description = "GitHub repository (owner/name) whose version tags may deploy to this account"
  type        = string
  default     = "AjayMaan13/fragments"
}

variable "project_name" {
  description = "Short name used as a prefix for resource names"
  type        = string
  default     = "fragments"
}

variable "alarm_email" {
  description = "Email for CloudWatch alarm notifications. Empty = alarms exist but notify nobody. Confirm the SNS subscription email AWS sends."
  type        = string
  default     = ""
}

variable "enable_password_auth" {
  description = "Allow username/password login for scripts (k6 load tests). Keep false otherwise; set true only for the duration of a test."
  type        = bool
  default     = false
}

variable "worker_desired_count" {
  description = "Running queue workers. Keep 0 until an image with src/worker.js is pushed; the async jobs API needs at least 1."
  type        = number
  default     = 0
}

variable "worker_cpu" {
  description = "Worker Fargate CPU units. Image conversion is CPU-bound (jpeg to avif took ~33 s on 256), so the worker gets more than the API."
  type        = string
  default     = "512"
}

variable "worker_memory" {
  description = "Worker Fargate memory (MiB), a valid pairing for worker_cpu"
  type        = string
  default     = "1024"
}
