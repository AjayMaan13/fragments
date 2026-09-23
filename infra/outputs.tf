output "ecr_repository_url" {
  description = "Push images here from the CD workflow"
  value       = module.ecr.repository_url
}

output "s3_bucket_name" {
  description = "Value for AWS_S3_BUCKET_NAME in the ECS task definition (Phase 3)"
  value       = module.storage.bucket_name
}

output "dynamodb_table_name" {
  description = "Value for AWS_DYNAMODB_TABLE_NAME in the ECS task definition (Phase 3)"
  value       = module.storage.table_name
}

output "task_execution_role_arn" {
  description = "Used as executionRoleArn in the ECS task definition (Phase 3)"
  value       = module.iam.task_execution_role_arn
}

output "task_role_arn" {
  description = "Used as taskRoleArn in the ECS task definition (Phase 3) — this is what your app code runs as"
  value       = module.iam.task_role_arn
}
