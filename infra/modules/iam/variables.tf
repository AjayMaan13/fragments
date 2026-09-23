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
