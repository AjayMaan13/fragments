variable "project_name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "cluster_id" {
  description = "ECS cluster to run in (the API's cluster)"
  type        = string
}

variable "image" {
  description = "Same image as the API; only the command differs"
  type        = string
}

variable "desired_count" {
  description = "Running workers. 0 means the service exists but runs nothing."
  type        = number
}

variable "cpu" {
  description = "Fargate CPU units (256, 512, 1024, ...). Conversions are CPU-bound: a 1080p jpeg to avif took ~33 s on 256."
  type        = string
  default     = "512"
}

variable "memory" {
  description = "Fargate memory in MiB; must be a valid pairing for the CPU"
  type        = string
  default     = "1024"
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  description = "The worker's own role (queue, jobs table, S3), not the API's"
  type        = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "s3_bucket_name" {
  type = string
}

variable "dynamodb_table_name" {
  type = string
}

variable "jobs_table_name" {
  type = string
}

variable "queue_url" {
  type = string
}
