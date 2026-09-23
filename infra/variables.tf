variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-2"
}

variable "project_name" {
  description = "Short name used as a prefix for resource names"
  type        = string
  default     = "fragments"
}
