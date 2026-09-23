variable "project_name" {
  description = "Prefix for security group names"
  type        = string
}

variable "container_port" {
  description = "Port the app listens on inside the container"
  type        = number
}
