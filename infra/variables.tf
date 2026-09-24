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
