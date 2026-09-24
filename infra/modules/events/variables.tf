variable "project_name" {
  type = string
}

variable "bucket_name" {
  description = "S3 bucket the expired fragments' data is deleted from"
  type        = string
}

variable "bucket_arn" {
  type = string
}

variable "stream_arn" {
  description = "ARN of the fragments table's DynamoDB stream"
  type        = string
}
