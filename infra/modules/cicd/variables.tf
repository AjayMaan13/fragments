variable "project_name" {
  type = string
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/name"
  type        = string
}

variable "ecr_repository_arn" {
  type = string
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_name" {
  type = string
}

variable "task_role_arns" {
  description = "Task execution and task role ARNs the deploy may pass to ECS"
  type        = list(string)
}
