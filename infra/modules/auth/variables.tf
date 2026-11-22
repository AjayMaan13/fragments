variable "project_name" {
  type = string
}

variable "enable_password_auth" {
  description = "Add ALLOW_USER_PASSWORD_AUTH to the app client so scripts (k6) can log in with a username and password. Keep false except while load testing."
  type        = bool
  default     = false
}

variable "callback_urls" {
  description = "URLs Cognito may redirect to after login/logout (exact match, mind trailing slashes)"
  type        = list(string)
}
