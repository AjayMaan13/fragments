variable "project_name" {
  description = "Prefix for load balancer and target group names"
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Subnets in at least two availability zones"
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group attached to the load balancer"
  type        = string
}

variable "container_port" {
  description = "Port the app listens on inside the container"
  type        = number
}
