variable "project_name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "image" {
  description = "Full image URI, e.g. <ecr repo url>:latest"
  type        = string
}

variable "container_port" {
  type = number
}

variable "desired_count" {
  description = "Number of running tasks. 0 means the service exists but runs nothing."
  type        = number
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "s3_bucket_name" {
  type = string
}

variable "dynamodb_table_name" {
  type = string
}

variable "api_url" {
  description = "Public base URL of the API, used for Location headers"
  type        = string
}

# Wired up in Phase 4 once the Cognito module exists.
variable "cognito_pool_id" {
  type    = string
  default = ""
}

variable "cognito_client_id" {
  type    = string
  default = ""
}
