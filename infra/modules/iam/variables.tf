variable "project_name" {
  description = "Used as a prefix for role names"
  type        = string
}

variable "bucket_arn" {
  description = "ARN of the S3 bucket the task role may read/write"
  type        = string
}

variable "table_arn" {
  description = "ARN of the DynamoDB table the task role may read/write"
  type        = string
}

variable "jobs_table_arn" {
  description = "ARN of the jobs DynamoDB table"
  type        = string
}

variable "queue_arn" {
  description = "ARN of the jobs SQS queue"
  type        = string
}
