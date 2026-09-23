variable "project_name" {
  type = string
}

variable "callback_urls" {
  description = "URLs Cognito may redirect to after login/logout (exact match, mind trailing slashes)"
  type        = list(string)
}
