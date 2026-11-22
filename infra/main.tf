module "ecr" {
  source = "./modules/ecr"

  project_name = var.project_name
}

module "storage" {
  source = "./modules/storage"

  project_name = var.project_name
}

module "iam" {
  source = "./modules/iam"

  project_name = var.project_name
  bucket_arn   = module.storage.bucket_arn
  table_arn    = module.storage.table_arn
}

module "network" {
  source = "./modules/network"

  project_name   = var.project_name
  container_port = var.container_port
}

module "alb" {
  source = "./modules/alb"

  project_name      = var.project_name
  vpc_id            = module.network.vpc_id
  subnet_ids        = module.network.subnet_ids
  security_group_id = module.network.alb_security_group_id
  container_port    = var.container_port
}

module "auth" {
  source = "./modules/auth"

  project_name         = var.project_name
  callback_urls        = var.ui_callback_urls
  enable_password_auth = var.enable_password_auth
}

module "ecs" {
  source = "./modules/ecs"

  project_name        = var.project_name
  aws_region          = var.aws_region
  image               = "${module.ecr.repository_url}:latest"
  container_port      = var.container_port
  desired_count       = var.desired_count
  execution_role_arn  = module.iam.task_execution_role_arn
  task_role_arn       = module.iam.task_role_arn
  subnet_ids          = module.network.subnet_ids
  security_group_id   = module.network.ecs_security_group_id
  target_group_arn    = module.alb.target_group_arn
  s3_bucket_name      = module.storage.bucket_name
  dynamodb_table_name = module.storage.table_name
  api_url             = "http://${module.alb.dns_name}"
  cognito_pool_id     = module.auth.user_pool_id
  cognito_client_id   = module.auth.client_id
}

module "events" {
  source = "./modules/events"

  project_name = var.project_name
  bucket_name  = module.storage.bucket_name
  bucket_arn   = module.storage.bucket_arn
  stream_arn   = module.storage.table_stream_arn
}

module "cicd" {
  source = "./modules/cicd"

  project_name       = var.project_name
  github_repo        = var.github_repo
  ecr_repository_arn = module.ecr.repository_arn
  ecs_cluster_name   = "${var.project_name}-cluster"
  ecs_service_name   = "${var.project_name}-service"
  task_role_arns     = [module.iam.task_execution_role_arn, module.iam.task_role_arn]
}

module "observability" {
  source = "./modules/observability"

  project_name            = var.project_name
  aws_region              = var.aws_region
  alb_arn_suffix          = module.alb.lb_arn_suffix
  target_group_arn_suffix = module.alb.target_group_arn_suffix
  ecs_cluster_name        = module.ecs.cluster_name
  ecs_service_name        = module.ecs.service_name
  log_group_name          = module.ecs.log_group_name
  alarm_email             = var.alarm_email
}
