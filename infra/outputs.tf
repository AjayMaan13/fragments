output "ecr_repository_url" {
  description = "Push images here from the CD workflow"
  value       = module.ecr.repository_url
}

output "api_url" {
  description = "Public URL of the load balancer"
  value       = "http://${module.alb.dns_name}"
}

output "cognito_user_pool_id" {
  description = "AWS_COGNITO_POOL_ID for fragments-ui/.env"
  value       = module.auth.user_pool_id
}

output "cognito_client_id" {
  description = "AWS_COGNITO_CLIENT_ID for fragments-ui/.env"
  value       = module.auth.client_id
}

output "cognito_hosted_ui_url" {
  description = "Login page base URL"
  value       = module.auth.hosted_ui_url
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
